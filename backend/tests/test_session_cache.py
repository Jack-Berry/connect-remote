"""Session cache behaviour: keying, TTL expiry, LRU cap, eviction."""

from types import SimpleNamespace

import pytest

from app.session_cache import SessionCache, credentials_key


def creds(**overrides):
    base = dict(username="u", password="p", pin="1234", region=1, brand=3)
    base.update(overrides)
    return SimpleNamespace(**base)


def test_key_is_stable_and_credential_sensitive():
    k = credentials_key("u", "p", "1234", 1, 3)
    assert k == credentials_key("u", "p", "1234", 1, 3)
    assert k != credentials_key("u", "p", "1234", 1, 2)
    assert k != credentials_key("u", "p", "9999", 1, 3)


def test_key_concatenation_is_unambiguous():
    # Without a separator, ("ab", "c") and ("a", "bc") would collide.
    assert credentials_key("ab", "c", "", 1, 1) != credentials_key("a", "bc", "", 1, 1)


def test_key_is_not_reversible_to_credentials():
    assert "hunter2" not in credentials_key("user", "hunter2", "0000", 1, 3)


def test_same_credentials_reuse_the_session():
    calls = []
    cache = SessionCache(factory=lambda c: calls.append(c) or object())
    s1 = cache.get_or_create(creds())
    s2 = cache.get_or_create(creds())
    assert s1 is s2
    assert len(calls) == 1


def test_different_credentials_get_different_sessions():
    cache = SessionCache(factory=lambda c: object())
    assert cache.get_or_create(creds()) is not cache.get_or_create(
        creds(username="v")
    )


def test_expired_session_is_evicted_and_rebuilt(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr("app.session_cache.time.monotonic", lambda: now[0])
    cache = SessionCache(factory=lambda c: object(), ttl_seconds=600)
    s1 = cache.get_or_create(creds())
    now[0] += 601
    s2 = cache.get_or_create(creds())
    assert s1 is not s2
    assert len(cache._sessions) == 1


def test_ttl_slides_with_use(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr("app.session_cache.time.monotonic", lambda: now[0])
    cache = SessionCache(factory=lambda c: object(), ttl_seconds=600)
    s1 = cache.get_or_create(creds())
    for _ in range(3):
        now[0] += 500  # each use inside the TTL keeps the session alive
        assert cache.get_or_create(creds()) is s1


def test_evict_removes_the_session():
    cache = SessionCache(factory=lambda c: object())
    s1 = cache.get_or_create(creds())
    cache.evict(s1.key)
    assert cache.get_or_create(creds()) is not s1


def test_max_sessions_evicts_least_recently_used():
    cache = SessionCache(factory=lambda c: object(), max_sessions=2)
    first = cache.get_or_create(creds(username="a"))
    cache.get_or_create(creds(username="b"))
    cache.get_or_create(creds(username="c"))  # evicts "a"
    assert len(cache._sessions) == 2
    assert cache.get_or_create(creds(username="a")) is not first
