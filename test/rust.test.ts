import { describe, expect, it } from 'vitest';
import { expectValid, P, skel } from './helpers.js';

describe('Rust', () => {
  const src = `//! Crate docs.
use std::collections::HashMap;
use serde::{Deserialize, Serialize};

/// A stored item.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    tags: Vec<String>,
}

pub enum Event {
    Created(Item),
    Deleted { id: String },
}

pub type Result<T> = std::result::Result<T, Error>;

pub trait Store: Send + Sync {
    fn get(&self, id: &str) -> Option<&Item>;
    fn len(&self) -> usize {
        0
    }
}

impl<K: Eq + std::hash::Hash> Cache<K> {
    /// Creates a cache.
    pub const fn new() -> Self {
        Self { map: HashMap::new() }
    }

    pub async fn refresh(&mut self) -> Result<()> {
        let data = fetch().await?;
        self.map.extend(data);
        Ok(())
    }
}

pub static HOOK: fn(i32) -> i32 = |x| {
    x + 1
};

macro_rules! square {
    ($x:expr) => { $x * $x };
}

#[cfg(test)]
mod tests {
    #[test]
    fn it_works() {
        assert_eq!(2 + 2, 4);
    }
}
`;

  it('strips fn and closure bodies but keeps items, traits, impls and macros', async () => {
    expect(await skel(src, 'rust')).toBe(`//! Crate docs.
use std::collections::HashMap;
use serde::{Deserialize, Serialize};

/// A stored item.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Item {
    pub id: String,
    tags: Vec<String>,
}

pub enum Event {
    Created(Item),
    Deleted { id: String },
}

pub type Result<T> = std::result::Result<T, Error>;

pub trait Store: Send + Sync {
    fn get(&self, id: &str) -> Option<&Item>;
    fn len(&self) -> usize ${P}
}

impl<K: Eq + std::hash::Hash> Cache<K> {
    /// Creates a cache.
    pub const fn new() -> Self ${P}

    pub async fn refresh(&mut self) -> Result<()> ${P}
}

pub static HOOK: fn(i32) -> i32 = |x| ${P};

macro_rules! square {
    ($x:expr) => { $x * $x };
}

#[cfg(test)]
mod tests {
    #[test]
    fn it_works() ${P}
}
`);
  });

  it('produces valid, idempotent output', async () => {
    const result = await expectValid(src, 'rust');
    expect(result.strippedBodies).toBe(5);
  });
});
