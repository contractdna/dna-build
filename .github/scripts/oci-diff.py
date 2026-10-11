# Diff two OCI image layouts (unpacked `docker buildx --output type=oci` tarballs) file by file, so a non-reproducible
# build names the exact files that differ: per layer, every entry's path, mode, owner, mtime, size and content sha256,
# plus the image config. Usage: python3 oci-diff.py <oci dir 1> <oci dir 2>   (exit 1 if they differ)
import hashlib, json, sys, tarfile

def blob(root, digest):
    return f"{root}/blobs/sha256/{digest.split(':')[1]}"

def describe(root):
    index = json.load(open(f"{root}/index.json"))
    manifest = json.load(open(blob(root, index["manifests"][0]["digest"])))
    config = json.load(open(blob(root, manifest["config"]["digest"])))
    layers = []
    for i, l in enumerate(manifest["layers"]):
        entries = {}
        with tarfile.open(blob(root, l["digest"]), mode="r:*") as t:  # gzip / zstd-less layers: r:* detects gzip
            for m in t:
                h = hashlib.sha256(t.extractfile(m).read()).hexdigest()[:16] if m.isfile() else m.linkname
                entries[m.name] = (oct(m.mode), m.uid, m.gid, int(m.mtime), m.size, h)
        layers.append((l["digest"], entries))
    return config, layers

c1, l1 = describe(sys.argv[1])
c2, l2 = describe(sys.argv[2])
different = False
for k in sorted(set(c1) | set(c2)):
    if c1.get(k) != c2.get(k):
        different = True
        print(f"config.{k}:\n  1: {json.dumps(c1.get(k))[:600]}\n  2: {json.dumps(c2.get(k))[:600]}")
for i, ((d1, e1), (d2, e2)) in enumerate(zip(l1, l2)):
    if d1 == d2:
        continue
    different = True
    print(f"layer {i}: {d1[:19]} ≠ {d2[:19]}")
    shown = 0
    for name in sorted(set(e1) | set(e2)):
        if e1.get(name) != e2.get(name) and shown < 40:
            shown += 1
            print(f"  {name}\n    1: {e1.get(name)}\n    2: {e2.get(name)}")
if len(l1) != len(l2):
    different = True
    print(f"layer count {len(l1)} ≠ {len(l2)}")
sys.exit(1 if different else 0)
