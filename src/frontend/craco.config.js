const path = require('path');

module.exports = {
  webpack: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
    configure: (webpackConfig) => {
      webpackConfig.resolve.plugins = webpackConfig.resolve.plugins.filter(
        (plugin) => plugin.constructor.name !== 'ModuleScopePlugin'
      );

      const oneOfRule = webpackConfig.module.rules.find((rule) => rule.oneOf);
      if (oneOfRule) {
        const tsRule = oneOfRule.oneOf.find((rule) =>
          rule.test && rule.test.toString().includes('tsx')
        );
        if (tsRule && tsRule.include) {
          tsRule.include = [
            tsRule.include,
            path.resolve(__dirname, '../shared'),
          ];
        }
      }
      return webpackConfig;
    },
  },
  devServer: {
    allowedHosts: 'all',
    host: 'localhost',
    port: process.env.PORT || 3100,
  },
  jest: {
    configure: (jestConfig) => {
      jestConfig.moduleNameMapper = {
        ...jestConfig.moduleNameMapper,
        '^@shared/(.*)$': '<rootDir>/../shared/$1',
      };
      return jestConfig;
    },
  },
};
