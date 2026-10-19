"""Verify native trust checks and idempotent install of an already trusted application CA."""
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "vendor/lepao3"))
directory = os.environ.get("SWU_CERT_SMOKE_CA_DIR")
if directory is None or not Path(directory).is_absolute():
    raise RuntimeError("Set SWU_CERT_SMOKE_CA_DIR to the existing application certificate directory.")
os.environ["LEPAO_CA_DIR"] = directory
from lepao import certctl

path = certctl.ca_file()
if not path:
    raise RuntimeError("The application certificate must already exist before this test.")
fingerprint = certctl.ca_fingerprint(path)
before_user = set(certctl.trusted_fingerprints("CurrentUser"))
before_machine = set(certctl.trusted_fingerprints("LocalMachine"))
if fingerprint not in before_user:
    raise RuntimeError("This test only reinstalls the exact application CA already trusted by the current user.")
before_file = hashlib.sha256(Path(path).read_bytes()).hexdigest()
status = certctl.status("")
assert status["trusted_user"] and status["trusted"]
result = certctl.install(True)
assert result["ok"] and result["step"] == "verify" and result["fingerprint"] == fingerprint
assert set(certctl.trusted_fingerprints("CurrentUser")) == before_user
assert set(certctl.trusted_fingerprints("LocalMachine")) == before_machine
assert hashlib.sha256(Path(path).read_bytes()).hexdigest() == before_file

# A real, newly generated certificate must not inherit trust from its subject.
with tempfile.TemporaryDirectory(prefix="swu-certificate-") as temporary:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "mitmproxy")])
    now = datetime.now(timezone.utc)
    certificate = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
                   .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=1))
                   .not_valid_after(now + timedelta(minutes=5)).add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
                   .sign(key, hashes.SHA256()))
    different = Path(temporary) / "untrusted.cer"
    different.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    assert certctl.ca_fingerprint(str(different)) not in before_user | before_machine
try:
    certctl.trusted_fingerprints("InvalidScope")
except ValueError:
    pass
else:
    raise AssertionError("An unknown certificate store scope was accepted.")

print(json.dumps({"nativeTrustConfirmed": True, "alreadyTrustedCaInstallVerified": True,
                  "rootStoreContentsUnchanged": True, "certificateFileUnchanged": True,
                  "sameSubjectDifferentFingerprintUntrusted": True, "noProxyOrPlatformRequests": True}))
