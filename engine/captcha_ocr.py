"""One-shot captcha OCR helper used by the desktop login window.

The desktop backend keeps login inside HTTP requests because the school WAF
rejects browser-side POSTs. This helper receives the captcha image that the
desktop already fetched, and returns the recognized digits.

Protocol: one JSON line on stdin ``{"image": "<base64>"}`` and one JSON line on
stdout ``{"code": "1234"}``. Unreadable images return an empty code; failures
are written to stderr with a non-zero exit code.
"""

import base64
import binascii
import json
import sys

MAXIMUM_IMAGE_BYTES = 512_000


def read_request() -> bytes:
    line = sys.stdin.readline()
    if not line:
        raise ValueError('No OCR request was provided on stdin.')
    payload = json.loads(line)
    if not isinstance(payload, dict):
        raise ValueError('The OCR request must be a JSON object.')
    encoded = payload.get('image')
    if not isinstance(encoded, str) or not encoded:
        raise ValueError('The OCR request is missing the base64 image field.')
    try:
        image = base64.b64decode(encoded, validate=True)
    except binascii.Error as exc:
        raise ValueError('The OCR image is not valid base64.') from exc
    if not image or len(image) > MAXIMUM_IMAGE_BYTES:
        raise ValueError(f'The OCR image size {len(image)} is outside the allowed range.')
    return image


def main() -> int:
    try:
        image = read_request()
        import ddddocr
    except Exception as exc:
        print(f'captcha-ocr failed: {exc}', file=sys.stderr)
        return 1
    ocr = ddddocr.DdddOcr(show_ad=False)
    code = (ocr.classification(image) or '').strip()
    print(json.dumps({'code': code}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
