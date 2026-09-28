# teideal-python

Official Python SDK for sending durable, idempotent usage events to Teideal.

```python
from teideal import TeidealClient

client = TeidealClient("https://usage.example.com", "api-key")
result = client.send_event("customer-uuid", "api.request", 1)
```

Events are written to a local SQLite buffer before transmission. The default
buffer is `~/.teideal/buffer.db`; pass `buffer_path` to override it.

