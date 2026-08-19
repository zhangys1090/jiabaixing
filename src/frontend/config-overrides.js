const { addWebpackAlias, override } = require('customize-cra');
const path = require('path');

module.exports = override(
  addWebpackAlias({
    '@shared': path.resolve(__dirname, '../shared'),
  })
);
