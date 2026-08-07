'use strict';

const Database = require('better-sqlite3');
const { DB_PATH } = require('../config');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 30000');

module.exports = db;
