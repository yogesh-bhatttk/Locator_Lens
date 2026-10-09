// Preloaded (node --require) into every exported Selenium JS/TS script that the
// export tests run. The script itself is run exactly as exported — this only
// changes how its `new Builder().forBrowser('chrome').build()` launches Chrome:
//   * the Chromium Playwright installed (LOCATRA_CHROMIUM), so a run needs no
//     separately installed Google Chrome and every framework drives one browser;
//   * headless (unless LOCATRA_E2E_HEADED=1), so it runs in CI without a display;
//   * an explicit chromedriver when LOCATRA_CHROMEDRIVER is set — otherwise
//     Selenium Manager resolves (and caches) the one matching that browser.
'use strict';

const process = require('node:process');

const { Builder } = require('selenium-webdriver');
const chrome = require('selenium-webdriver/chrome');

const originalBuild = Builder.prototype.build;
Builder.prototype.build = function build() {
  const options = this.getChromeOptions() || new chrome.Options();
  if (process.env.LOCATRA_CHROMIUM) options.setChromeBinaryPath(process.env.LOCATRA_CHROMIUM);
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,900'];
  if (process.env.LOCATRA_E2E_HEADED !== '1') args.push('--headless=new');
  options.addArguments(...args);
  this.setChromeOptions(options);
  if (process.env.LOCATRA_CHROMEDRIVER) {
    this.setChromeService(new chrome.ServiceBuilder(process.env.LOCATRA_CHROMEDRIVER));
  }
  return originalBuild.call(this);
};
