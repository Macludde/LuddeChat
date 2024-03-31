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
const checkBalance = require('~/models/checkBalance');

const payForDallE = async (plugin, ...tx) => {
  const input = plugin.inputs[0]?.toLowerCase();
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
      ...tx,
      model: 'DALL-E',
      context: 'message',
      valueKey: 'dall-e',
    },
    {
      promptTokens: 0,
      completionTokens: 40000 * quality,
    },
  );
};

const checkBalanceForDallE = async (dalleInput, tx) => {
  console.log('Checking for balance', dalleInput);
  let quality = 1;
  if (dalleInput.quality !== 'standard') {
    // not "standard" quality
    quality++;
  }
  if (dalleInput.size !== '1024x1024') {
    // not "1024x1024" size
    quality++;
  }
  await checkBalance({
    ...tx,
    txData: {
      ...tx.txData,
      tokenType: 'completion',
      amount: 40000 * quality,
      model: 'DALL-E',
      context: 'message',
      valueKey: 'dall-e',
    },
  });
};

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
          if (!output.startsWith('![')) {
            return; // no image generated
          }
          payForDallE(plugins[pluginIndex], {
            user,
            conversationId,
          });
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

    const onAgentAction = async (action, runId) => {
      if (action.tool === 'dalle') {
        try {
          await checkBalanceForDallE(action.toolInput, {
            req,
            res,
            txData: { user, conversationId },
          });
        } catch (error) {
          handleAbortError(res, req, error, {
            conversationId,
            sender,
            messageId: responseMessageId,
            parentMessageId: userMessageId ?? parentMessageId,
          });
        }
      }
      pluginMap.set(runId, action.tool);
      sendIntermediateMessage(res, { plugins });
    };

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
