'use strict';
// One stable, opaque key per chat: a hash of the account and the person's id on that platform. It is the primary key of the
// chat archive, so the assistant fetches exactly ONE chat for a reply (a direct key lookup) and never scans or receives the others.
const crypto = require('node:crypto');

function chatKey(accountId, personId) {
  return crypto.createHash('sha256').update(`ig:${accountId}:${personId}`).digest('hex').slice(0, 24);
}

module.exports = { chatKey };
