"""Built-in data source implementations.

Importing this package triggers registration of the default sources
(``yfinance``, ``hyperliquid``, ``forex``) into the registry in
``data_source.py``.
"""

from . import yfinance_source  # noqa: F401  (side-effect: register)
from . import hyperliquid_source  # noqa: F401  (side-effect: register)
from . import forex_source  # noqa: F401  (side-effect: register)
