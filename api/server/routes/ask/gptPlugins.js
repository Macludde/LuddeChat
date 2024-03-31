const express = require('express');
const throttle = require('lodash/throttle');
const { getResponseSender, Constants } = require('librechat-data-provider');
const { initializeClient } = require('~/server/services/Endpoints/gptPlugins');
const { saveMessage, getConvoTitle, getConvo } = require('~/models');
const { sendMessage, createOnProgress } = require('~/server/utils');
const { addTitle } = require('~/server/services/Endpoints/openAI');
const {
  handleAbort,
  createAbortController,
  handleAbortError,
  setHeaders,
  validateModel,
  validateEndpoint,
  buildEndpointOption,
  moderateText,
} = require('~/server/middleware');
const { validateTools } = require('~/app');
const { logger } = require('~/config');
const spendTokens = require('~/models/spendTokens');

const router = express.Router();

router.use(moderateText);
router.post('/abort', handleAbort());

router.post(
  '/',
  validateEndpoint,
  validateModel,
  buildEndpointOption,
  setHeaders,
  async (req, res) => {
    let {
      text,
      endpointOption,
      conversationId,
      parentMessageId = null,
      overrideParentMessageId = null,
    } = req.body;

    logger.debug('[/ask/gptPlugins]', { text, conversationId, ...endpointOption });

    let userMessage;
    let promptTokens;
    let userMessageId;
    let responseMessageId;
    const sender = getResponseSender({
      ...endpointOption,
      model: endpointOption.modelOptions.model,
    });
    const newConvo = !conversationId;
    const user = req.user.id;

    const plugins = [];

    const getReqData = (data = {}) => {
      for (let key in data) {
        if (key === 'userMessage') {
          userMessage = data[key];
          userMessageId = data[key].messageId;
        } else if (key === 'responseMessageId') {
          responseMessageId = data[key];
        } else if (key === 'promptTokens') {
          promptTokens = data[key];
        } else if (!conversationId && key === 'conversationId') {
          conversationId = data[key];
        }
      }
    };

    const throttledSaveMessage = throttle(saveMessage, 3000, { trailing: false });
    let streaming = null;
    let timer = null;

    const {
      onProgress: progressCallback,
      sendIntermediateMessage,
      getPartialText,
    } = createOnProgress({
      onProgress: ({ text: partialText }) => {
        if (timer) {
          clearTimeout(timer);
        }

        throttledSaveMessage({
          messageId: responseMessageId,
          sender,
          conversationId,
          parentMessageId: overrideParentMessageId || userMessageId,
          text: partialText,
          model: endpointOption.modelOptions.model,
          unfinished: true,
          error: false,
          plugins,
          user,
        });

        streaming = new Promise((resolve) => {
          timer = setTimeout(() => {
            resolve();
          }, 250);
        });
      },
    });

    const pluginMap = new Map();
    const onAgentAction = async (action, runId) => {
      pluginMap.set(runId, action.tool);
      sendIntermediateMessage(res, { plugins });
    };

    const onToolStart = async (tool, input, runId, parentRunId) => {
      const pluginName = pluginMap.get(parentRunId);
      const latestPlugin = {
        runId,
        loading: true,
        inputs: [input],
        latest: pluginName,
        outputs: null,
      };

      if (streaming) {
        await streaming;
      }
      const extraTokens = ':::plugin:::\n';
      plugins.push(latestPlugin);
      sendIntermediateMessage(res, { plugins }, extraTokens);
    };

    const onToolEnd = async (output, runId) => {
      if (streaming) {
        await streaming;
      }

      const pluginIndex = plugins.findIndex((plugin) => plugin.runId === runId);

      if (pluginIndex !== -1) {
        plugins[pluginIndex].loading = false;
        plugins[pluginIndex].outputs = output;
        console.log(
          pluginIndex,
          plugins[pluginIndex],
          plugins[pluginIndex].latest,
          plugins[pluginIndex].inputs[0],
        );
        // For Dall-E, spend tokens based on the quality of the image
        if (plugins[pluginIndex].latest === 'dalle') {
          if (!plugins[pluginIndex].outputs.startsWith('![')) {
            return; // no image generated
          }
          const input = plugins[pluginIndex].inputs[0]?.toLowerCase();
          /* Pricing is like this:
          Standard, 1024x1024: $0.04 per image
          Standard	1024×1792, 1792×1024 $0.08 per image
          HD	1024×1024 $0.08 per image
          HD	1024×1792, 1792×1024 $0.12 per image

          In other words: Standard 1024x1024 is quality 1,
          Increasing either to HD or size increases quality to 2
          Increasing both increases quality to 3
          For each quality, price is increased by $0.04
           */
          let quality = 1;
          if (input && !input.includes('"quality":"standard"')) {
            // not "standard" quality
            quality++;
          }
          if (input && !input.includes('"size":"1024x1024"')) {
            // not "1024x1024" size
            quality++;
          }
          await spendTokens(
            {
              user,
              conversationId,
              model: 'DALL-E',
              context: 'message',
              valueKey: 'dall-e',
            },
            {
              promptTokens: 0,
              completionTokens: 40000 * quality,
            },
          );
        }
      }
    };

    const onChainEnd = () => {
      saveMessage({ ...userMessage, user });
      sendIntermediateMessage(res, { plugins });
    };

    const getAbortData = () => ({
      sender,
      conversationId,
      messageId: responseMessageId,
      parentMessageId: overrideParentMessageId ?? userMessageId,
      text: getPartialText(),
      plugins: plugins.map((p) => ({ ...p, loading: false })),
      userMessage,
      promptTokens,
    });
    const { abortController, onStart } = createAbortController(req, res, getAbortData);

    try {
      endpointOption.tools = await validateTools(user, endpointOption.tools);
      const { client } = await initializeClient({ req, res, endpointOption });

      let response = await client.sendMessage(text, {
        user,
        conversationId,
        parentMessageId,
        overrideParentMessageId,
        getReqData,
        onAgentAction,
        onChainEnd,
        onToolStart,
        onToolEnd,
        onStart,
        getPartialText,
        ...endpointOption,
        onProgress: progressCallback.call(null, {
          res,
          text,
          parentMessageId: overrideParentMessageId || userMessageId,
          plugins,
        }),
        abortController,
      });

      if (overrideParentMessageId) {
        response.parentMessageId = overrideParentMessageId;
      }

      logger.debug('[/ask/gptPlugins]', response);

      response.plugins = plugins.map((p) => ({ ...p, loading: false }));
      await saveMessage({ ...response, user });

      sendMessage(res, {
        title: await getConvoTitle(user, conversationId),
        final: true,
        conversation: await getConvo(user, conversationId),
        requestMessage: userMessage,
        responseMessage: response,
      });
      res.end();

      if (parentMessageId === Constants.NO_PARENT && newConvo) {
        addTitle(req, {
          text,
          response,
          client,
        });
      }
    } catch (error) {
      const partialText = getPartialText();
      handleAbortError(res, req, error, {
        partialText,
        conversationId,
        sender,
        messageId: responseMessageId,
        parentMessageId: userMessageId ?? parentMessageId,
      });
    }
  },
);

module.exports = router;
