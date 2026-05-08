// Example plugin — copy to ~/.bima/plugins/ to activate
module.exports = {
  name: 'example',
  description: 'Contoh plugin Bima',
  // CLI commands added to Bima
  commands: {
    '/ping': async (args, ctx) => { ctx.log('INFO', 'Pong!'); },
  },
  // Agent tools added to the AI agent
  tools: [
    {
      name: 'example_tool',
      description: 'Contoh tool dari plugin',
      async execute(input, tenantId) { return `Tool dijalankan dengan input: ${input}`; },
    },
  ],
};
