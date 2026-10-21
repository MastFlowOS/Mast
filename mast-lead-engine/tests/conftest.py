import pytest
from workers.website_worker import WebsiteWorker


@pytest.fixture(autouse=True)
def _reset_website_worker_cache():
    WebsiteWorker.clear_cache()
    yield
    WebsiteWorker.clear_cache()
