/**
 * Mock for screenshot-desktop module
 * Used in tests to avoid actual screen capture
 */

const screenshotDesktop = jest.fn();

screenshotDesktop.mockImplementation(
  (opts: { filename?: string; format?: string; screen?: number }) => {
    return Promise.resolve();
  }
);

module.exports = screenshotDesktop;
