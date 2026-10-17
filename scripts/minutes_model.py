"""Private, independent model selection for post-meeting minutes only."""
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request


class MinutesModelError(RuntimeError):
    """Stop automatic meeting retries after a dedicated-provider request fails."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class MinutesModel:
    def __init__(self, config):
        if config.get('provider') != 'openai-compatible':
            raise ValueError('minutes model: unsupported provider')
        base = config.get('base_url', '')
        if not isinstance(base, str):
            raise ValueError('minutes model: expected an HTTPS base URL')
        parsed = urllib.parse.urlsplit(base)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment):
            raise ValueError('minutes model: expected a private HTTPS base URL')
        self.key, self.model = config.get('api_key'), config.get('model')
        if not all(isinstance(v, str) and v.strip() for v in (self.key, self.model)):
            raise ValueError('minutes model: missing key or model')
        self.url = base.rstrip('/') + '/chat/completions'
        self.timeout = config.get('timeout_seconds', 180)
        if type(self.timeout) not in (int, float) or not 1 <= self.timeout <= 600:
            raise ValueError('minutes model: timeout must be 1–600 seconds')

    def complete_json(self, system, user, timeout=120):
        body = dict(model=self.model, temperature=0, response_format={'type': 'json_object'},
                    max_tokens=8192, messages=[dict(role='system', content=system), dict(role='user', content=user)])
        request = urllib.request.Request(self.url, data=json.dumps(body, ensure_ascii=False).encode(),
            headers={'Authorization': 'Bearer ' + self.key, 'Content-Type': 'application/json'})
        # Preserve TLS verification; never forward credentials through redirects or retry an unknown POST.
        try:
            with urllib.request.build_opener(_NoRedirect()).open(request, timeout=self.timeout) as response:
                raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise ValueError('oversize response')
            result = json.loads(raw)
            if result.get('model') != self.model:
                raise ValueError('unexpected returned model')
            choice = result['choices'][0]
            if choice.get('finish_reason') != 'stop':
                raise ValueError('incomplete response')
            value = json.loads(choice['message']['content'])
            if not isinstance(value, dict):
                raise ValueError('expected JSON object')
            return value, result.get('model', self.model)
        except urllib.error.HTTPError as error:
            raise MinutesModelError(f'minutes model HTTP {error.code}; request not retried') from None
        except (OSError, ValueError, KeyError, IndexError, TypeError, AttributeError):
            raise MinutesModelError('minutes model response unavailable or invalid; request not retried') from None


def load_minutes_model():
    """No config preserves the existing model; invalid explicit config never silently falls back."""
    configured = os.environ.get('OOPS_MINUTES_CONFIG')
    path = Path(configured).expanduser() if configured else Path.home() / '.config/oops/minutes-model.json'
    if not path.exists() and not configured:
        return None
    try:
        if path.stat().st_mode & 0o077:
            raise ValueError('minutes model config must be private (0600)')
        config = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        raise ValueError('minutes model config missing or unreadable') from None
    if not isinstance(config, dict):
        raise ValueError('minutes model config must be a JSON object')
    return MinutesModel(config)
