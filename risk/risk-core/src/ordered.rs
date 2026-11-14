//! A map that keeps insertion order, like a Python dict. The reference adds up holdings and lists scenarios
//! in dict order, and floating-point sums depend on their order, so account holdings keep theirs.
use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, Serializer};
use std::fmt;
use std::marker::PhantomData;

/// Entries in insertion order. Lookups are linear, which is fast for the handful of keys an account holds.
#[derive(Clone, Debug, PartialEq)]
pub struct OrderedMap<V> {
    entries: Vec<(String, V)>,
}

impl<V> Default for OrderedMap<V> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
        }
    }
}

impl<V> OrderedMap<V> {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut V> {
        self.entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// `d[key] = value`: a new key goes last; an existing key keeps its place.
    pub fn insert(&mut self, key: &str, value: V) {
        match self.get_mut(key) {
            Some(v) => *v = value,
            None => self.entries.push((key.to_string(), value)),
        }
    }

    /// `del d[key]`: the other keys keep their order.
    pub fn remove(&mut self, key: &str) -> Option<V> {
        let i = self.entries.iter().position(|(k, _)| k == key)?;
        Some(self.entries.remove(i).1)
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(k, _)| k.as_str())
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.entries.iter().map(|(_, v)| v)
    }
}

impl<V: Copy> OrderedMap<V> {
    /// `d.get(key, default)`.
    pub fn get_or(&self, key: &str, default: V) -> V {
        self.get(key).copied().unwrap_or(default)
    }
}

impl<V> std::ops::Index<&str> for OrderedMap<V> {
    type Output = V;

    /// `d[key]`, which raises if the key is missing.
    fn index(&self, key: &str) -> &V {
        self.get(key).unwrap_or_else(|| panic!("no key {key:?}"))
    }
}

impl<K: AsRef<str>, V> FromIterator<(K, V)> for OrderedMap<V> {
    /// Like `dict(pairs)`: a repeated key keeps its first place and takes the last value.
    fn from_iter<I: IntoIterator<Item = (K, V)>>(iter: I) -> Self {
        let mut map = Self::new();
        for (k, v) in iter {
            map.insert(k.as_ref(), v);
        }
        map
    }
}

impl<V: Serialize> Serialize for OrderedMap<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.entries.len()))?;
        for (k, v) in &self.entries {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

/// Reads a JSON object in document order, or a list of `[key, value]` pairs (which keeps its order even
/// through `serde_json::Value`, whose objects are sorted).
impl<'de, V: Deserialize<'de>> Deserialize<'de> for OrderedMap<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OrderedVisitor<V>(PhantomData<V>);

        impl<'de, V: Deserialize<'de>> Visitor<'de> for OrderedVisitor<V> {
            type Value = OrderedMap<V>;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a map, or a list of [key, value] pairs")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut map = OrderedMap::new();
                while let Some((k, v)) = access.next_entry::<String, V>()? {
                    map.insert(&k, v);
                }
                Ok(map)
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut map = OrderedMap::new();
                while let Some((k, v)) = access.next_element::<(String, V)>()? {
                    map.insert(&k, v);
                }
                Ok(map)
            }
        }

        deserializer.deserialize_any(OrderedVisitor(PhantomData))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn behaves_like_a_python_dict() {
        let mut d: OrderedMap<f64> = [("nBTC", 1.0), ("USDC", 2.0)].into_iter().collect();
        d.insert("USDC", 3.0);
        d.insert("wNEAR", 4.0);
        assert_eq!(d.keys().collect::<Vec<_>>(), ["nBTC", "USDC", "wNEAR"]);
        assert_eq!(d.remove("nBTC"), Some(1.0));
        assert_eq!(d.keys().collect::<Vec<_>>(), ["USDC", "wNEAR"]);
        assert_eq!(d.get_or("ETH.b", 0.5), 0.5);
        assert_eq!(d["USDC"], 3.0);
    }

    #[test]
    fn reads_objects_in_document_order_and_lists_of_pairs() {
        let a: OrderedMap<f64> = serde_json::from_str(r#"{"z": 1, "a": 2}"#).unwrap();
        assert_eq!(a.keys().collect::<Vec<_>>(), ["z", "a"]);
        let b: OrderedMap<f64> = serde_json::from_str(r#"[["z", 1], ["a", 2]]"#).unwrap();
        assert_eq!(a, b);
        assert_eq!(serde_json::to_string(&b).unwrap(), r#"{"z":1.0,"a":2.0}"#);
    }
}
