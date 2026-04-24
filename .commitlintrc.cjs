const base = require('@precisa-saude/commitlint-config');

/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  ...base,
  rules: {
    ...base.rules,
    'scope-enum': [2, 'always', ['data', 'schema', 'scripts', 'ci', 'deps', 'docs', 'lint', 'config']],
  },
};
