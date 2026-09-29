import local from './local-plugin.mjs';

export default [{
  files: ['**/*.ts'],
  plugins: { local },
  rules: { 'local/report': 'error', 'no-console': 'error' },
}];
