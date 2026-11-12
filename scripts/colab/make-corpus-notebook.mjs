// Builds scripts/colab/chandra-corpus-lora.ipynb — trains Qwen3-14B on Vaughn's own writing (build-corpus.mjs output)
// and measures, inside Colab, how well the model knows held-out files before and after (bits per byte).
// Run: node scripts/colab/make-corpus-notebook.mjs  (regenerate after editing; do not hand-edit the .ipynb)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const lines = text => text.trim().split('\n').map((l, i, a) => l + (i < a.length - 1 ? '\n' : ''));
const md = text => ({ cell_type: 'markdown', metadata: {}, source: lines(text) });
const code = text => ({ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: lines(text) });

const cells = [
  md(`
# Chandra — corpus adapter (Qwen3-14B on Vaughn's own writing)

Teaches the model that answers most of Chandra's calls (qwen3:14b) what is in Vaughn's own projects: \`train.jsonl\`
from \`node scripts/colab/build-corpus.mjs\` (the r8 corpus minus third-party code, upstream ACE-Step and anything
secret-shaped; each chunk starts with \`# file: <path>\`). No API key is needed.

**Before you start:** Runtime → Change runtime type → **A100**. Have \`train.jsonl\`, \`heldout.jsonl\` and the two
sha256 values from the corpus \`manifest.json\`. Both files are uploaded; **held-out text is only scored, never trained on.**

What this measures here: bits per byte on the held-out files, before and after — the same unit as FraynixGPT's r9 numbers.
What it does not measure: whether Chandra's work gets better. That is checked at home (films, tools, forgetting).
`),
  md('## 1. Install (Colab only)'),
  code(`
%%capture
!pip install unsloth
`),
  md('## 2. Upload both files and check they are the ones exported'),
  code(`
import hashlib, json
from google.colab import files
EXPECTED = {"train": "", "heldout": ""}   # paste train.sha256 and heldout.sha256 from manifest.json
data = {}
for part in ("train", "heldout"):
    print(f"choose {part}.jsonl")
    up = files.upload(); name = next(iter(up)); raw = up[name]
    got = hashlib.sha256(raw).hexdigest()
    assert not EXPECTED[part] or got == EXPECTED[part], f"{name} is not the exported {part}.jsonl"
    data[part] = [json.loads(l)["text"] for l in raw.decode("utf-8").splitlines() if l.strip()]
    print(part, len(data[part]), "chunks,", sum(len(t.encode()) for t in data[part]), "bytes, sha256", got)
`),
  md('## 3. Load Qwen3-14B in 4-bit with a small adapter (rank 16)'),
  code(`
from unsloth import FastLanguageModel
MAX_LEN = 2048
model, tokenizer = FastLanguageModel.from_pretrained(model_name="unsloth/Qwen3-14B", max_seq_length=MAX_LEN, load_in_4bit=True)
model = FastLanguageModel.get_peft_model(
    model, r=16, lora_alpha=16, lora_dropout=0, bias="none",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth", random_state=3407,
)
`),
  md(`
## 4. Held-out bits per byte BEFORE training

The adapter starts at zero, so this is the base model. Every held-out chunk is scored once (truncated at 2,048 tokens).
`),
  code(`
import math, torch
def heldout_bits_per_byte(texts):
    model.eval(); nats, nbytes, ntok = 0.0, 0, 0
    with torch.no_grad():
        for t in texts:
            ids = tokenizer(t, return_tensors="pt", truncation=True, max_length=MAX_LEN).input_ids.to("cuda")
            if ids.shape[1] < 2: continue
            loss = model(input_ids=ids, labels=ids).loss.item()
            nats += loss * (ids.shape[1] - 1); ntok += ids.shape[1] - 1
            nbytes += len(tokenizer.decode(ids[0][1:], skip_special_tokens=True).encode("utf-8"))
    return nats / math.log(2) / nbytes, ntok
before, ntok = heldout_bits_per_byte(data["heldout"])
print(f"BEFORE: held-out {before:.4f} bits/byte over {ntok} tokens")
`),
  md(`
## 5. Train one pass over the corpus

One epoch (about 2,500 chunks), lr 1e-4. Packing joins short chunks so no compute is wasted on padding.
`),
  code(`
from datasets import Dataset
from trl import SFTTrainer, SFTConfig
FastLanguageModel.for_training(model)
ds = Dataset.from_list([{"text": t + tokenizer.eos_token} for t in data["train"]])
trainer = SFTTrainer(
    model=model, tokenizer=tokenizer, train_dataset=ds,
    args=SFTConfig(
        dataset_text_field="text", max_seq_length=MAX_LEN, packing=True, per_device_train_batch_size=2,
        gradient_accumulation_steps=8, num_train_epochs=1, learning_rate=1e-4, warmup_steps=10,
        lr_scheduler_type="cosine", logging_steps=5, optim="adamw_8bit", weight_decay=0.01, seed=3407,
        output_dir="out", report_to="none",
    ),
)
stats = trainer.train()
print(stats)
`),
  md('## 6. Held-out bits per byte AFTER training — the knowledge measure'),
  code(`
after, _ = heldout_bits_per_byte(data["heldout"])
print(f"AFTER : held-out {after:.4f} bits/byte   (before {before:.4f}; change {after - before:+.4f}, {100 * (after - before) / before:+.1f} %)")
print("lower is better: the model predicts Vaughn's unseen files more accurately")
`),
  md('## 7. Save to Drive: adapter, q4_k_m GGUF, and the numbers'),
  code(`
import os, shutil, glob, datetime
from google.colab import drive
drive.mount("/content/drive")
stamp = datetime.datetime.utcnow().strftime("%Y-%m-%d-%H%M")
dest = f"/content/drive/MyDrive/chandra-lora/corpus-{stamp}"
os.makedirs(dest, exist_ok=True)
model.save_pretrained(f"{dest}/adapter"); tokenizer.save_pretrained(f"{dest}/adapter")
model.save_pretrained_gguf("gguf", tokenizer, quantization_method="q4_k_m")
for f in glob.glob("gguf/*.gguf") + glob.glob("gguf*/*.gguf"):
    h = hashlib.sha256()
    with open(f, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 24), b""): h.update(chunk)
    shutil.copy(f, dest)
    print(os.path.basename(f), os.path.getsize(f), "bytes sha256", h.hexdigest())
open(f"{dest}/TRAINED.txt", "w").write(
    f"corpus adapter: base unsloth/Qwen3-14B, {len(data['train'])} train chunks, 1 epoch, lr 1e-4, r 16\\n"
    f"held-out bits/byte before {before:.4f} after {after:.4f}\\n{stats}\\n")
print("saved to", dest)
`),
  md(`
## 8. Back home

Download the \`.gguf\`, then:

\`\`\`
node scripts/colab/import-adapter.mjs <file.gguf> --sha256 <hash> --name qwen3-chandra-corpus:14b
node scripts/colab/measure-adapter.mjs --base qwen3:14b --candidate qwen3-chandra-corpus:14b
\`\`\`

and the forgetting check. Adopt only if the knowledge measure improved and nothing at home got worse.
`),
];

const nb = { nbformat: 4, nbformat_minor: 5, metadata: { accelerator: 'GPU', colab: { provenance: [], gpuType: 'A100' }, kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } }, cells };
const out = join(dirname(fileURLToPath(import.meta.url)), 'chandra-corpus-lora.ipynb');
writeFileSync(out, JSON.stringify(nb, null, 1) + '\n');
console.log('wrote', out, cells.length, 'cells');
