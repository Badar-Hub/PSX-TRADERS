module.exports = function babel(api) {
  api.cache(true);
  return {
    // babel-preset-expo already includes the expo-router plugin and the
    // Reanimated/worklets handling, so there is nothing else to add here.
    presets: ['babel-preset-expo'],
  };
};
