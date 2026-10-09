# pytest-playwright configuration for the exported Playwright Python test that the
# export tests run (the test file itself is exactly as exported). Points the
# `page` fixture's browser at the Chromium Playwright installed (LOCATRA_CHROMIUM),
# so Python and Node drive the same build without a second browser download.
import os

import pytest


@pytest.fixture(scope="session")
def browser_type_launch_args(browser_type_launch_args):
    args = dict(browser_type_launch_args)
    binary = os.environ.get("LOCATRA_CHROMIUM")
    if binary:
        args["executable_path"] = binary
    if os.environ.get("LOCATRA_E2E_HEADED") == "1":
        args["headless"] = False
    return args
