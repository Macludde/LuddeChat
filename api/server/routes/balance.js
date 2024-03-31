const express = require('express');
const controller = require('../controllers/Balance');
const { requireJwtAuth } = require('~/server/middleware');
const NordigenClient = require('nordigen-node');
const { getUser } = require('~/models');
const { Transaction } = require('~/models/Transaction');
const logger = require('~/config/winston');

const router = express.Router();
router.use(requireJwtAuth);
router.get('/', controller);

const EXCHANGE_API_KEY = process.env.EXCHANGE_API_KEY;

let krToCred = 100000;
const convertKrToCred = (kr) => Math.floor(kr * krToCred);
let lastExchangeCheck = 0;
const updateExchangeRate = async () => {
  const exchangeRate = await fetch(
    `https://api.freecurrencyapi.com/v1/latest?apikey=${EXCHANGE_API_KEY}&currencies=SEK`,
  ).then((res) => res.json());
  const rate = exchangeRate.data['SEK'];
  krToCred = Math.floor(1000000 / rate);
};
updateExchangeRate();
router.get('/exchange', async (req, res) => {
  if (Date.now() - lastExchangeCheck > 1000 * 60 * 60 * 24) {
    // more than 24 hours have passed
    await updateExchangeRate();
  }
  res.status(200).send(krToCred.toString());
});

const client = new NordigenClient({
  secretId: process.env.GO_CARDLESS_SECRET_ID,
  secretKey: process.env.GO_CARDLESS_SECRET_KEY,
});

// Generate new access token. Token is valid for 24 hours
let tokenData;
client.generateToken().then((data) => {
  tokenData = data;
});
let tokenGottenAt = Date.now();
let refreshTokenGottenAt = Date.now();
const ten_minutes_ago = () => {
  return new Date(new Date().getTime() - 10 * 60 * 1000).toISOString().slice(0, 10);
};

router.post('/payment', async (req, res) => {
  console.log('payment');
  if (Date.now() - tokenGottenAt > 1000 * 60 * 60 * 23) {
    // more than 23 hours have passed
    if (Date.now() - refreshTokenGottenAt > 1000 * 60 * 60 * 24 * 29) {
      // more than 29 days have passed
      tokenData = await client.generateToken();
      tokenGottenAt = Date.now();
      refreshTokenGottenAt = Date.now();
    } else {
      // Exchange refresh token. Refresh token is valid for 30 days
      tokenData = await client.exchangeToken({ refreshToken: tokenData.refreshToken });
      tokenGottenAt = Date.now();
    }
  }
  console.log(req.body);
  const newAmount = req.body?.amount;
  if (!newAmount) {
    res.status(400).send('Amount is required');
  }

  // Update exchange rate if necessary
  if (Date.now() - lastExchangeCheck > 1000 * 60 * 60 * 24) {
    // more than 24 hours have passed
    await updateExchangeRate();
  }

  try {
    const beforeDate = ten_minutes_ago();
    const account = client.account(process.env.GO_CARDLESS_ACCOUNT_ID);
    const data = await account.getTransactions({ dateFrom: beforeDate });
    const booked = data.transactions.booked;
    const pending = data.transactions.pending;

    const userId = req.user.id;
    const user = await getUser(userId);
    const fullName = user.name.toUpperCase();

    const relevantTransactionsFromUser = [...booked, ...pending]
      .filter(
        (transaction) => transaction.remittanceInformationUnstructured.toUpperCase() === fullName,
      )
      .map((transaction) => ({
        ...transaction,
        amount: Number.parseFloat(transaction.transactionAmount.amount),
      }))
      .filter(
        (transaction) =>
          transaction.amount > newAmount * 0.9 && transaction.amount < newAmount * 1.1,
      );
    const previousSimularTransactions = await Transaction.find({
      user: userId,
      tokenType: 'credits',
      context: 'payment',
      rawAmount: {
        $gt: convertKrToCred(newAmount) * 0.9,
        $lt: convertKrToCred(newAmount) * 1.1,
      },
      createdAt: {
        $gt: new Date(beforeDate + 'T00:00:00.000Z'),
      },
    });

    if (relevantTransactionsFromUser.length > previousSimularTransactions.length) {
      logger.info(
        `${user.name} has made a payment of ${newAmount} kr and received ${convertKrToCred(
          newAmount,
        )} credits.`,
      );
      await Transaction.create({
        user: userId,
        tokenType: 'credits',
        context: 'payment',
        rawAmount: convertKrToCred(newAmount),
      });
      res.status(200).send('ok');
    }
    res.status(400).send('Could not verify transaction');
  } catch (err) {
    console.log('error', err);
    res.status(500).send('Could not verify transaction, please contact owner.');
    return;
  }
});

module.exports = router;
