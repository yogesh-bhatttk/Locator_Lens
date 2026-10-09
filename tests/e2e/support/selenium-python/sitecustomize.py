# Imported automatically at interpreter start-up (this directory is put on
# PYTHONPATH) for every exported Selenium Python script the export tests run.
# The script itself runs exactly as exported; this only changes how its
# `webdriver.Chrome()` launches Chrome:
#   * the Chromium Playwright installed (LOCATRA_CHROMIUM), so a run needs no
#     separately installed Google Chrome and every framework drives one browser;
#   * headless (unless LOCATRA_E2E_HEADED=1), so it runs in CI without a display;
#   * an explicit chromedriver when LOCATRA_CHROMEDRIVER is set; otherwise
#     Selenium Manager resolves (and caches) the one matching that browser.
import os

try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.chrome.service import Service
except ImportError:  # not a Selenium run
    webdriver = None

if webdriver is not None:
    _Chrome = webdriver.Chrome

    class _LocatraChrome(_Chrome):
        def __init__(self, options=None, service=None, keep_alive=True):
            options = options or Options()
            binary = os.environ.get("LOCATRA_CHROMIUM")
            if binary:
                options.binary_location = binary
            for arg in ("--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900"):
                options.add_argument(arg)
            if os.environ.get("LOCATRA_E2E_HEADED") != "1":
                options.add_argument("--headless=new")
            driver = os.environ.get("LOCATRA_CHROMEDRIVER")
            if service is None and driver:
                service = Service(executable_path=driver)
            super().__init__(options=options, service=service, keep_alive=keep_alive)

    webdriver.Chrome = _LocatraChrome
