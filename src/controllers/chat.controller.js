'use strict';

const chatService = require('../services/chat.service');
const { runChatAndRespond } = require('../utils/http-chat-relay');

async function postChat(req, res) {
  await runChatAndRespond(req, res, (signal) => chatService.handleChat(req.body, { signal }));
}

module.exports = { postChat };
