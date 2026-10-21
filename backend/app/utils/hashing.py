import hashlib
from pathlib import Path


def calculate_sha256(file_path: Path) -> str:
    """Calculate SHA256 hash of a file."""
    sha256_hash = hashlib.sha256()
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(4096), b""):
            sha256_hash.update(byte_block)
    return sha256_hash.hexdigest()


def calculate_md5(file_path: Path) -> str:
    """MD5 of a file: the id boorus publish for a post's original."""
    md5_hash = hashlib.md5()  # noqa: S324 - matching identifier, not security
    with open(file_path, "rb") as f:
        for byte_block in iter(lambda: f.read(1 << 20), b""):
            md5_hash.update(byte_block)
    return md5_hash.hexdigest()


def calculate_sha256_from_bytes(data: bytes) -> str:
    """Calculate SHA256 hash from bytes."""
    return hashlib.sha256(data).hexdigest()
