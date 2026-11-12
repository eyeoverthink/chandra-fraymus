// Builds scripts/colab/chandra-lora.ipynb — the Colab notebook that trains Chandra's first LoRA adapter.
// Run: node scripts/colab/make-notebook.mjs   (regenerate after editing the cells below; do not hand-edit the .ipynb)
// Plan and reasons: docs/WEIGHTS-AND-GEMINI-OUTLINE.md section 3.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const md = text => ({ cell_type: 'markdown', metadata: {}, source: text.trim().split('\n').map((l, i, a) => l + (i < a.length - 1 ? '\n' : '')) });
const code = text => ({ cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: text.trim().split('\n').map((l, i, a) => l + (i < a.length - 1 ? '\n' : '')) });

const cells = [
  md(`
# Chandra — first LoRA adapter (qwen3:14b)

Trains a small adapter on **Chandra's own verified work** (\`train.jsonl\` from \`POST /api/intelligence/distill/export\`),
then exports a GGUF that Ollama on fraymus-home can run. Nothing here needs an API key.

**Before you start:** Runtime → Change runtime type → a GPU (A100 or L4). Have \`train.jsonl\` and its \`sha256\` from
\`manifest.json\` ready. **Do not upload \`heldout.jsonl\`** — the adapter is measured on it back home.

What leaves your PC: only \`train.jsonl\` (agent runs you rated 👍, tool-using runs whose calls all succeeded, verified
programs, film scripts the checker accepted). What comes back: one \`.gguf\` file and the small adapter, saved to your Drive.
`),
  md('## 1. Install (Colab only — nothing is installed on your PC)'),
  code(`
%%capture
!pip install unsloth
`),
  md('## 2. Upload `train.jsonl` and check it is the file that was exported'),
  code(`
import hashlib, json
from google.colab import files
EXPECTED_SHA256 = ""   # paste train.sha256 from manifest.json here
up = files.upload()
name = next(iter(up))
data = up[name]
got = hashlib.sha256(data).hexdigest()
print("sha256", got)
assert not EXPECTED_SHA256 or got == EXPECTED_SHA256, "this is not the exported train.jsonl"
rows = [json.loads(l) for l in data.decode("utf-8").splitlines() if l.strip()]
from collections import Counter
print(len(rows), "records", Counter(r["source"] for r in rows))
open("train.jsonl", "w", encoding="utf-8").write("\\n".join(json.dumps({"messages": r["messages"]}) for r in rows) + "\\n")
`),
  md(`
## 3. Load the base model in 4-bit and add the adapter

\`unsloth/Qwen3-14B\` is the same model fraymus-home serves as \`qwen3:14b\`. The adapter is small (rank 16), and the
learning rate is low on purpose: about forty examples can teach a habit, and too many steps would teach them by heart.
`),
  code(`
from unsloth import FastLanguageModel
MAX_LEN = 4096
model, tokenizer = FastLanguageModel.from_pretrained(model_name="unsloth/Qwen3-14B", max_seq_length=MAX_LEN, load_in_4bit=True)
model = FastLanguageModel.get_peft_model(
    model, r=16, lora_alpha=16, lora_dropout=0, bias="none",
    target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    use_gradient_checkpointing="unsloth", random_state=3407,
)
`),
  md(`
## 4. Format with the model's own chat template

Thinking is off, as Chandra calls qwen3 with \`think: false\`. Tool calls and tool results keep their roles, so the adapter
learns to make a call rather than describe one.
`),
  code(`
from datasets import load_dataset
ds = load_dataset("json", data_files="train.jsonl", split="train")
def fmt(batch):
    return {"text": [tokenizer.apply_chat_template(m, tokenize=False, add_generation_prompt=False, enable_thinking=False) for m in batch["messages"]]}
ds = ds.map(fmt, batched=True, remove_columns=ds.column_names)
lengths = [len(tokenizer(t).input_ids) for t in ds["text"]]
print("records", len(ds), "longest", max(lengths), "tokens; over", MAX_LEN, ":", sum(l > MAX_LEN for l in lengths))
print(ds[0]["text"][:1500])
`),
  md('## 5. Train — only the assistant turns are learned (the task and tool results are context, not targets)'),
  code(`
from trl import SFTTrainer, SFTConfig
from unsloth.chat_templates import train_on_responses_only
trainer = SFTTrainer(
    model=model, tokenizer=tokenizer, train_dataset=ds,
    args=SFTConfig(
        dataset_text_field="text", max_seq_length=MAX_LEN, per_device_train_batch_size=1, gradient_accumulation_steps=4,
        num_train_epochs=2, learning_rate=1e-4, warmup_steps=3, lr_scheduler_type="linear",
        logging_steps=1, optim="adamw_8bit", weight_decay=0.01, seed=3407, output_dir="out", report_to="none",
    ),
)
trainer = train_on_responses_only(trainer, instruction_part="<|im_start|>user\\n", response_part="<|im_start|>assistant\\n")
stats = trainer.train()
print(stats)
`),
  md('## 6. A quick look (not the measurement — that happens at home on the held-out set)'),
  code(`
FastLanguageModel.for_inference(model)
msgs = [{"role": "system", "content": "You are fraymus_prime, an agent of Chandra-FRAYMUS. When a task needs a tool, call it; never describe a call you did not make."},
        {"role": "user", "content": "Check how many self-audit findings are open."}]
ids = tokenizer.apply_chat_template(msgs, tokenize=True, add_generation_prompt=True, enable_thinking=False, return_tensors="pt").to("cuda")
out = model.generate(input_ids=ids, max_new_tokens=200, temperature=0.2)
print(tokenizer.decode(out[0][ids.shape[1]:], skip_special_tokens=False))
`),
  md('## 7. Save to Drive: the adapter (small) and a GGUF Ollama can run (q4_k_m, about 9 GB)'),
  code(`
import os, shutil, glob, hashlib, datetime
from google.colab import drive
drive.mount("/content/drive")
stamp = datetime.datetime.utcnow().strftime("%Y-%m-%d-%H%M")
dest = f"/content/drive/MyDrive/chandra-lora/{stamp}"
os.makedirs(dest, exist_ok=True)
model.save_pretrained(f"{dest}/adapter"); tokenizer.save_pretrained(f"{dest}/adapter")
model.save_pretrained_gguf("gguf", tokenizer, quantization_method="q4_k_m")
for f in glob.glob("gguf/*.gguf") + glob.glob("gguf*/*.gguf"):
    h = hashlib.sha256()
    with open(f, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 24), b""): h.update(chunk)
    shutil.copy(f, dest)
    print(os.path.basename(f), os.path.getsize(f), "bytes sha256", h.hexdigest())
open(f"{dest}/TRAINED.txt", "w").write(f"base unsloth/Qwen3-14B, records {len(ds)}, epochs 2, lr 1e-4, r 16, train sha256 {got}\\n{stats}\\n")
print("saved to", dest)
`),
  md(`
## 8. Back home

Download the \`.gguf\` from Drive, then on the PC:

\`\`\`
node scripts/colab/import-adapter.mjs <path to the .gguf> --sha256 <the sha256 printed above>
\`\`\`

It copies the file to fraymus-home, creates \`qwen3-chandra:14b\` there with qwen3:14b's own template, and changes nothing
else. The adapter is **not** used by the app until \`measure-adapter.mjs\` shows it does better on the held-out set.
`),
];

const nb = { nbformat: 4, nbformat_minor: 5, metadata: { accelerator: 'GPU', colab: { provenance: [], gpuType: 'A100' }, kernelspec: { name: 'python3', display_name: 'Python 3' }, language_info: { name: 'python' } }, cells };
const out = join(dirname(fileURLToPath(import.meta.url)), 'chandra-lora.ipynb');
writeFileSync(out, JSON.stringify(nb, null, 1) + '\n');
console.log('wrote', out, cells.length, 'cells');
