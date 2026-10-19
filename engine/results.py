"""Expose bounded, credential-free summaries from the encrypted submission journal."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import math
from pathlib import Path
from typing import Literal, TypedDict
from lepao.private_storage import read_private_json

BEIJING = timezone(timedelta(hours=8))


class SubmissionSummary(TypedDict):
    submittedAt: str
    checkedAt: str | None
    distanceKm: float | None
    durationSeconds: float | None
    status: Literal['valid', 'invalid', 'pending']


def _object(value: object) -> dict[str, object]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ValueError('Local submission journal must contain objects with string keys.')
    return value


def _entries(value: object) -> list[dict[str, object]]:
    if not isinstance(value, list):
        raise ValueError('Local submission journal entries must be a list.')
    return [_object(entry) for entry in value]


def _timestamp(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError('Local submission timestamp is missing.')
    stamp = datetime.fromisoformat(value)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=BEIJING)
    return stamp.isoformat()


def _number(value: object) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        raise ValueError('Local submission metric has an invalid type.')
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise ValueError('Local submission metric must be a finite nonnegative number.')
    return number


def submission_summaries(directory: Path) -> dict[str, SubmissionSummary]:
    path = directory / 'state.json'
    if not path.exists():
        return {}
    config = read_private_json(directory / 'config.json')
    accounts = _object(config.get('accounts'))
    journal = read_private_json(path)
    entries = _entries(journal.get('submissions', []))
    watches = _entries(journal.get('watch_log', []))
    result: dict[str, SubmissionSummary] = {}
    for key, value in accounts.items():
        account = _object(value)
        uid = account.get('uid')
        label = account.get('alias') or account.get('name') or key
        tags = {key, f'{label}#{uid}'}
        matching = [entry for entry in entries if entry.get('member') in tags or (uid and str(entry.get('uid')) == str(uid))]
        if not matching:
            continue
        entry = matching[-1]
        details = [watch for watch in watches if entry.get('record_id') and watch.get('record_id') == entry.get('record_id')]
        latest = details[-1] if details else entry
        status = str(latest.get('status') if details else latest.get('record_status'))
        reason = str((latest.get('reason') if details else latest.get('record_failed_reason')) or '')
        negative = any(word in reason for word in ('无效', '异常', '不通过', '不合格'))
        verdict: Literal['valid', 'invalid', 'pending'] = 'invalid' if status == '5' or negative else 'valid' if entry.get('record_id') and status == '1' and (not reason.strip() or '有效' in reason) else 'pending'
        result[key] = {'submittedAt': _timestamp(entry.get('at')), 'checkedAt': _timestamp(latest.get('at')) if details else None,
                       'distanceKm': _number(entry.get('distance')), 'durationSeconds': _number(entry.get('used_time')), 'status': verdict}
    return result
