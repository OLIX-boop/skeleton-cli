import { describe, expect, it } from 'vitest';
import { skeletonize } from '../src/index.js';
import { expectValid, skel } from './helpers.js';

const py = (s: string) => skel(s, 'python');

describe('Python', () => {
  it('strips function bodies and keeps signatures with type hints', async () => {
    const src = `import os
from typing import Optional

def load(path: str, *, encoding: str = "utf-8") -> Optional[bytes]:
    if not os.path.exists(path):
        return None
    with open(path, "rb") as fh:
        return fh.read()
`;
    expect(await py(src)).toBe(`import os
from typing import Optional

def load(path: str, *, encoding: str = "utf-8") -> Optional[bytes]:
    ...
`);
  });

  it('keeps docstrings and replaces the rest of the body', async () => {
    const src = `def area(r: float) -> float:
    """Return the area of a circle.

    Args:
        r: radius
    """
    import math
    return math.pi * r ** 2
`;
    expect(await py(src)).toBe(`def area(r: float) -> float:
    """Return the area of a circle.

    Args:
        r: radius
    """
    ...
`);
  });

  it('keeps class structure, fields, decorators and nested classes', async () => {
    const src = `@dataclass(frozen=True)
class User(BaseModel):
    """A user."""

    id: int
    name: str = "anon"
    tags: list[str] = field(default_factory=list)

    class Meta:
        table = "users"

    def __init__(self, id: int) -> None:
        super().__init__()
        self.id = id

    @property
    def display(self) -> str:
        """Human readable."""
        return f"{self.name} ({self.id})"

    @staticmethod
    async def fetch(id: int) -> "User":
        async with session() as s:
            return await s.get(User, id)

    @classmethod
    def build(cls, **kw): return cls(**kw)
`;
    expect(await py(src)).toBe(`@dataclass(frozen=True)
class User(BaseModel):
    """A user."""

    id: int
    name: str = "anon"
    tags: list[str] = field(default_factory=list)

    class Meta:
        table = "users"

    def __init__(self, id: int) -> None:
        ...

    @property
    def display(self) -> str:
        """Human readable."""
        ...

    @staticmethod
    async def fetch(id: int) -> "User":
        ...

    @classmethod
    def build(cls, **kw): ...
`);
    await expectValid(src, 'python');
  });

  it('strips nested functions with their parent and keeps lambdas', async () => {
    const src = `def decorator(fn):
    def wrapper(*args, **kwargs):
        return fn(*args, **kwargs)
    return wrapper

square = lambda x: x * x
`;
    const result = await skeletonize(src, 'python');
    expect(result.code).toBe(`def decorator(fn):
    ...

square = lambda x: x * x
`);
    expect(result.strippedBodies).toBe(1);
  });

  it('leaves stubs, protocols and pass-only bodies untouched', async () => {
    const src = `class Repo(Protocol):
    def get(self, id: int) -> Item: ...
    def put(self, item: Item) -> None:
        """Store an item."""
    def noop(self):
        pass
`;
    const result = await skeletonize(src, 'python');
    expect(result.code).toBe(src);
    expect(result.strippedBodies).toBe(0);
  });

  it('keeps module-level code and constants', async () => {
    const src = `"""Module docstring."""
__all__ = ["main"]
DEBUG = os.environ.get("DEBUG") == "1"

def main() -> int:
    print("hi")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
`;
    expect(await py(src)).toBe(src.replace(`    print("hi")\n    return 0\n`, `    ...\n`));
  });

  it('keeps a one-line docstring on one-line functions', async () => {
    expect(await py(`def f(): "Doc."; return 1\n`)).toBe(`def f(): "Doc."; ...\n`);
  });

  it('wraps a custom placeholder in a comment', async () => {
    const out = await skeletonize('def f():\n    return 1\n', 'python', { placeholder: 'omitted' });
    expect(out.code).toBe('def f():\n    ...  # omitted\n');
  });
});
