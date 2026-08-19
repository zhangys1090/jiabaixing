const path = require('path');

module.exports = {
  webpack: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  jest: {
    configure: {
      moduleNameMapper: {
        '^@shared/(.*)$': '<rootDir>/src/shared/$1',
      },
    },
  },
};
