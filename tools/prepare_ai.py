"""Export the AnimeGANv2 face-paint generator for the app.

Writes (into the folders given on the command line):
  <assets>/face_paint_v2.json  tensor names, shapes, offsets
  <assets>/face_paint_v2.bin   all weights as float16, concatenated
  <ref>/MODEL.txt              printed module tree
  <ref>/model.py               the original model source, for reference
  <ref>/ref_*.bin              a test input and the PyTorch outputs, float32
"""
import json
import shutil
import sys

import numpy as np
import torch

sys.path.insert(0, "/tmp/ag")
from model import Generator  # noqa: E402

assets, ref = sys.argv[1], sys.argv[2]

net = Generator()
net.load_state_dict(torch.load("/tmp/face_paint_512_v2.pt", map_location="cpu"))
net.eval()

sd = net.state_dict()
manifest, chunks, off = [], [], 0
for name, t in sd.items():
    a = t.detach().cpu().numpy().astype(np.float16)
    manifest.append({"name": name, "shape": list(a.shape), "offset": off, "length": int(a.size)})
    chunks.append(a.tobytes())
    off += a.size
with open(f"{assets}/face_paint_v2.bin", "wb") as f:
    f.write(b"".join(chunks))
with open(f"{assets}/face_paint_v2.json", "w") as f:
    json.dump({"dtype": "float16", "source": "bryandlee/animegan2-pytorch face_paint_512_v2", "tensors": manifest}, f)

with open(f"{ref}/MODEL.txt", "w") as f:
    f.write(str(net))
shutil.copy("/tmp/ag/model.py", f"{ref}/model.py")
for extra in ("hubconf.py", "test.py", "LICENSE"):
    try:
        shutil.copy(f"/tmp/ag/{extra}", f"{ref}/{extra}")
    except FileNotFoundError:
        pass

# reference outputs with the same float16-rounded weights the app uses
with torch.no_grad():
    for t in sd.values():
        t.copy_(t.half().float())
    yy, xx = np.mgrid[0:96, 0:96] / 95.0
    img = np.stack([np.sin(xx * 6) * 0.8, np.cos(yy * 5) * 0.7, (xx - yy) * 0.9], 0).astype(np.float32)
    x = torch.from_numpy(img)[None]
    x.numpy().astype(np.float32).tofile(f"{ref}/ref_input_1x3x96x96.bin")
    for align in (False, True):
        y = net(x, align)
        y.numpy().astype(np.float32).tofile(f"{ref}/ref_output_align{int(align)}_1x3x96x96.bin")
print("exported", len(manifest), "tensors,", off, "values")
