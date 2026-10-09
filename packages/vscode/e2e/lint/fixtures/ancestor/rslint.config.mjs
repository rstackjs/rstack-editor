// The only Rslint config in this fixture. The opened workspace folder is
// `packages/app`, so detection must find this file above the folder.
export default [
  {
    files: ['**/*.ts'],
    rules: {
      'no-debugger': 'error',
    },
  },
];
