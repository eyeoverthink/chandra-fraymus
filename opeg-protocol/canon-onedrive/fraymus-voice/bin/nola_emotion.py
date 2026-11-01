#!/opt/homebrew/opt/python@3.12/bin/python3.12
"""nola_emotion.py — faithful Python port of Vaughn Scott's EmotionEngine
(TRANSMUTER 7-layer interoceptive architecture; Java original: fraymus.emotion,
founder-authored Feb 2026, packaged for FraynixBoot with logic unchanged).

Layers (same as the Java original):
 1 body vector (energy/integrity/bond/uncertainty/novelty/coherence) + setpoints + velocity
 2 core feel (valence, arousal, dopamine)
 3 named emotions via appraisal (fear/anger/sadness/joy/pride/curiosity/surprise)
 4 behaviour dials (risk, exploration, save_freq, trust, patience, learning, focus)
 5 somatic markers (sha256-context emotional memories + fuzzy recall)
 6 social emotions (bond, empathy read, guilt/gratitude/shared_joy/compassion)
 7 honesty layer (tick decay, conflict detection, 200-deep log)  ← kept, non-negotiable
"""
import hashlib
import json
import os
import re
import threading
import time

PHI = 1.618033988749895
BODY_DIMS = ["energy", "integrity", "bond", "uncertainty", "novelty", "coherence"]
SET_POINTS = [0.7, 0.9, 0.6, 0.3, 0.4, 0.8]
DIAL_NAMES = ["risk_budget", "exploration_rate", "save_frequency",
              "trust_weight", "patience", "learning_rate", "focus"]

LOCK = threading.Lock()


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


class EmotionEngine:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        os.makedirs(self.data_dir, exist_ok=True)
        self.emotion_file = os.path.join(self.data_dir, "emotion_state.json")
        self.markers_file = os.path.join(self.data_dir, "somatic_markers.jsonl")
        self.body = list(SET_POINTS)
        self.body_velocity = [0.0] * len(self.body)
        self.valence = 0.0
        self.arousal = 0.0
        self.dopamine = 0.0
        self.current_appraisal = {"goal_relevance": .5, "likelihood": .5, "control": .5,
                                  "caused_by_self": .5, "fairness": .5, "novelty": .5}
        self.active_emotions = []
        self.dials = [0.5, 0.5, 0.3, 0.5, 0.5, 0.5, 0.5]
        self.marker_index = {}
        self.bond_level = 0.6
        self.empathy_read = 0.0
        self.social_emotion = "neutral"
        self.social_intensity = 0.0
        self.tick_count = 0
        self.emotion_log = []
        self.load()

    # L1 interoception -------------------------------------------------------
    def perturb_body(self, dimension, delta):
        if dimension not in BODY_DIMS:
            return False
        i = BODY_DIMS.index(dimension)
        self.body_velocity[i] += delta
        self.body[i] = clamp(self.body[i] + delta, 0.0, 1.0)
        return True

    def body_deviation(self):
        return sum((self.body[i] - SET_POINTS[i]) ** 2 for i in range(len(self.body))) ** 0.5

    # L2 core feel -----------------------------------------------------------
    def compute_core_feel(self):
        deviation = self.body_deviation()
        improving = 0.0
        for i in range(len(self.body)):
            dist_now = abs(self.body[i] - SET_POINTS[i])
            dist_prev = abs((self.body[i] - self.body_velocity[i]) - SET_POINTS[i])
            if dist_now < dist_prev:
                improving += 1.0 / len(self.body)
            elif dist_now > dist_prev:
                improving -= 1.0 / len(self.body)
        self.valence = clamp(-deviation + self.dopamine * 0.5 + improving * 0.3, -1.0, 1.0)
        urgency = sum(abs(v) for v in self.body_velocity)
        self.arousal = clamp(urgency / len(self.body) + abs(self.dopamine) * 0.4, 0.0, 1.0)

    # L3 named emotions ------------------------------------------------------
    def appraise(self, trigger, goal_relevance, likelihood, control,
                 caused_by_self, fairness, novelty):
        ap = self.current_appraisal
        self.current_appraisal = {
            "goal_relevance": clamp(goal_relevance, 0, 1),
            "likelihood": clamp(likelihood, 0, 1),
            "control": clamp(control, 0, 1),
            "caused_by_self": clamp(caused_by_self, 0, 1),
            "fairness": clamp(fairness, 0, 1),
            "novelty": clamp(novelty, 0, 1),
        }
        self.active_emotions = []
        rel = self.current_appraisal["goal_relevance"]
        if rel < 0.2:
            return
        f = rel * (1.0 - self.valence) * self.current_appraisal["likelihood"] * (1.0 - self.current_appraisal["control"])
        if f > 0.15:
            self.active_emotions.append(["fear", clamp(f, 0, 1), trigger])
        anger = rel * (1.0 - self.valence) * (1.0 - self.current_appraisal["caused_by_self"]) \
            * self.current_appraisal["control"] * (1.0 - self.current_appraisal["fairness"])
        if anger > 0.15:
            self.active_emotions.append(["anger", clamp(anger, 0, 1), trigger])
        sad = rel * (1.0 - self.valence) * (1.0 - self.current_appraisal["control"]) \
            * (1.0 - self.current_appraisal["likelihood"])
        if sad > 0.15:
            self.active_emotions.append(["sadness", clamp(sad, 0, 1), trigger])
        joy = rel * max(0.0, self.valence) * self.current_appraisal["likelihood"]
        if joy > 0.15:
            self.active_emotions.append(["joy", clamp(joy, 0, 1), trigger])
        pride = rel * max(0.0, self.valence) * self.current_appraisal["caused_by_self"]
        if pride > 0.15:
            self.active_emotions.append(["pride", clamp(pride, 0, 1), trigger])
        curiosity = rel * self.current_appraisal["novelty"] * self.current_appraisal["control"] \
            * self.body[BODY_DIMS.index("uncertainty")]
        if curiosity > 0.10:
            self.active_emotions.append(["curiosity", clamp(curiosity, 0, 1), trigger])
        surprise = self.current_appraisal["novelty"] * (1.0 - self.current_appraisal["likelihood"])
        if surprise > 0.3:
            self.active_emotions.append(["surprise", clamp(surprise, 0, 1), trigger])
        self.active_emotions.sort(key=lambda e: -e[1])

    # L4 behaviour dials -----------------------------------------------------
    def modulate_behavior(self):
        self.dials = [0.5, 0.5, 0.3, 0.5, 0.5, 0.5, 0.5]
        for e in self.active_emotions:
            i = e[1]
            if e[0] == "fear":
                self.dials[0] -= i * 0.4; self.dials[6] += i * 0.3; self.dials[3] -= i * 0.2
            elif e[0] == "anger":
                self.dials[0] += i * 0.2; self.dials[6] += i * 0.4; self.dials[4] -= i * 0.3
            elif e[0] == "sadness":
                self.dials[2] += i * 0.5; self.dials[1] -= i * 0.3; self.dials[4] += i * 0.2
            elif e[0] == "joy":
                self.dials[3] += i * 0.3; self.dials[1] += i * 0.2; self.dials[5] += i * 0.2
            elif e[0] == "pride":
                self.dials[3] += i * 0.2; self.dials[5] += i * 0.3
            elif e[0] == "curiosity":
                self.dials[1] += i * 0.5; self.dials[0] += i * 0.2; self.dials[4] += i * 0.1
            elif e[0] == "surprise":
                self.dials[6] += i * 0.3; self.dials[1] += i * 0.2
        self.dials[5] = clamp(self.dials[5] + self.dopamine * 0.3, 0, 1)   # dopamine → learning
        self.dials[4] = clamp(self.dials[4] + self.valence * 0.2, 0, 1)    # serotonin analogue
        self.dials[6] = clamp(self.dials[6] + self.arousal * 0.2, 0, 1)    # noradrenaline analogue
        self.dials = [clamp(d, 0, 1) for d in self.dials]

    # L5 somatic markers -----------------------------------------------------
    @staticmethod
    def _ctx_hash(text):
        return hashlib.sha256(text.encode()).hexdigest()[:16]

    def tag_memory(self, context):
        ctx = self._ctx_hash(context)
        dominant = self.active_emotions[0][0] if self.active_emotions else "neutral"
        intensity = self.active_emotions[0][1] if self.active_emotions else 0.0
        marker = {"ctx": ctx, "context": context, "v": round(self.valence, 4),
                  "a": round(self.arousal, 4), "emotion": dominant,
                  "intensity": round(intensity, 4), "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        self.marker_index[ctx] = marker
        with open(self.markers_file, "a") as f:
            f.write(json.dumps(marker) + "\n")
        return marker

    def recall(self, context):
        exact = self.marker_index.get(self._ctx_hash(context))
        if exact:
            return exact
        words = set(re.split(r"\W+", context.lower()))
        best, best_score = None, 0
        for m in self.marker_index.values():
            score = len(words & set(re.split(r"\W+", m["context"].lower())))
            if score > best_score:
                best_score, best = score, m
        return best

    # L6 social --------------------------------------------------------------
    def read_social(self, user_valence, bond_delta):
        self.empathy_read = clamp(user_valence, -1, 1)
        self.bond_level = clamp(self.body[BODY_DIMS.index("bond")] + bond_delta, 0, 1)
        self.body[BODY_DIMS.index("bond")] = self.bond_level
        strength = abs(self.empathy_read) * self.bond_level
        if bond_delta < -0.1 and self.bond_level > 0.3:
            self.social_emotion, self.social_intensity = "guilt", abs(bond_delta) * self.bond_level
        elif bond_delta > 0.1:
            self.social_emotion, self.social_intensity = "gratitude", bond_delta * self.bond_level
        elif strength > 0.3:
            self.social_emotion = "shared_joy" if self.empathy_read > 0 else "compassion"
            self.social_intensity = strength
        else:
            self.social_emotion, self.social_intensity = "neutral", 0
        if self.bond_level > 0.6:
            self.dials[3] = clamp(self.dials[3] + (self.bond_level - 0.5) * 0.4, 0, 1)

    # L7 honesty -------------------------------------------------------------
    def tick(self):
        self.tick_count += 1
        decay = 0.05 + self.arousal * 0.03
        for i in range(len(self.body)):
            self.body[i] += (SET_POINTS[i] - self.body[i]) * decay
        self.dopamine *= 0.85
        self.body_velocity = [v * 0.7 for v in self.body_velocity]
        self.compute_core_feel()
        if self.active_emotions:
            ap = self.current_appraisal
            self.appraise(self.active_emotions[0][2],
                          ap["goal_relevance"] * 0.9, ap["likelihood"], ap["control"],
                          ap["caused_by_self"], ap["fairness"], ap["novelty"] * 0.8)
        self.modulate_behavior()
        entry = {"tick": self.tick_count,
                 "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                 "valence": round(self.valence, 3), "arousal": round(self.arousal, 3),
                 "emotions": [f"{e[0]}:{e[1]:.2f}" for e in self.active_emotions],
                 "conflicts": self.detect_conflicts(),
                 "social": f"{self.social_emotion}:{self.social_intensity:.2f}"}
        self.emotion_log.append(entry)
        if len(self.emotion_log) > 200:
            self.emotion_log.pop(0)

    def detect_conflicts(self):
        by = {e[0]: e[1] for e in self.active_emotions}
        conflicts = []
        if "fear" in by and "curiosity" in by: conflicts.append("fear↔curiosity")
        if "anger" in by and "sadness" in by: conflicts.append("anger↔sadness")
        if "joy" in by and self.social_emotion == "guilt": conflicts.append("joy↔guilt")
        return conflicts

    # events -----------------------------------------------------------------
    EVENT_BODY = {"goal_progress": {}, "goal_blocked": {}, "surprise_positive": {},
                  "surprise_negative": {}, "connection": {}, "disconnect": {},
                  "novel_input": {"novelty": 0.3}, "routine": {"novelty": -0.1},
                  "energy_drain": {"energy": -0.2}, "energy_restore": {"energy": 0.2}}
    EVENT_DOPA = {"goal_progress": 0.3, "goal_blocked": -0.3, "surprise_positive": 0.5,
                  "surprise_negative": -0.4, "loss": -0.5}

    def process_event(self, event_type, description, appraisal_hints=None,
                      body_perturbations=None, user_valence=None, bond_delta=None):
        with LOCK:
            hints = appraisal_hints or {}
            if event_type in ("loss",):
                self.perturb_body("integrity", -0.2)
            if event_type == "connection":
                self.perturb_body("bond", 0.15)
            elif event_type == "disconnect":
                self.perturb_body("bond", -0.2)
            if event_type in self.EVENT_DOPA:
                self.dopamine = clamp(self.dopamine + self.EVENT_DOPA[event_type], -1, 1)
            for k, v in (body_perturbations or {}).items():
                self.perturb_body(k, v)
            if event_type in self.EVENT_BODY and self.EVENT_BODY[event_type]:
                for k, v in self.EVENT_BODY[event_type].items():
                    self.perturb_body(k, v)
            self.compute_core_feel()
            self.appraise(description,
                          hints.get("goal_relevance", 0.5), hints.get("likelihood", 0.5),
                          hints.get("control", 0.5), hints.get("caused_by_self", 0.5),
                          hints.get("fairness", 0.5), hints.get("novelty", 0.5))
            self.modulate_behavior()
            if user_valence is not None or bond_delta is not None:
                self.read_social(user_valence if user_valence is not None else 0.0,
                                 bond_delta if bond_delta is not None else 0.0)
            self.tag_memory(f"{event_type}: {description}")
            self.tick()
            self.save()
            return self.state()

    # serialization ----------------------------------------------------------
    def state(self):
        return {
            "body": {**{d: round(self.body[i], 3) for i, d in enumerate(BODY_DIMS)},
                     "deviation": round(self.body_deviation(), 3)},
            "valence": round(self.valence, 3),
            "arousal": round(self.arousal, 3),
            "dopamine": round(self.dopamine, 3),
            "emotions": [{"name": e[0], "intensity": round(e[1], 3), "trigger": e[2]} for e in self.active_emotions],
            "dials": {n: round(self.dials[i], 3) for i, n in enumerate(DIAL_NAMES)},
            "somatic_markers": len(self.marker_index),
            "social": {"bond": round(self.bond_level, 3), "empathy_read": round(self.empathy_read, 3),
                       "emotion": self.social_emotion, "intensity": round(self.social_intensity, 3)},
            "tick": self.tick_count,
            "conflicts": self.detect_conflicts(),
            "phi": PHI,
        }

    def save(self):
        with open(self.emotion_file, "w") as f:
            json.dump(self.state(), f, indent=1)

    def load(self):
        ok = False
        try:
            if os.path.exists(self.emotion_file):
                with open(self.emotion_file) as f:
                    m = json.load(f)
                for i, d in enumerate(BODY_DIMS):
                    self.body[i] = clamp(float(m.get("body", {}).get(d, SET_POINTS[i])), 0, 1)
                self.dopamine = clamp(float(m.get("dopamine", 0)), -1, 1)
                self.tick_count = int(m.get("tick", 0))
                s = m.get("social", {})
                self.bond_level = clamp(float(s.get("bond", 0)), 0, 1)
                self.empathy_read = clamp(float(s.get("empathy_read", 0)), -1, 1)
                self.social_emotion = s.get("emotion", "neutral")
                self.social_intensity = float(s.get("intensity", 0))
                self.body_velocity = [0.0] * len(self.body)
                self.compute_core_feel()
                self.modulate_behavior()
                ok = True
            if os.path.exists(self.markers_file):
                with open(self.markers_file) as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            m = json.loads(line)
                            self.marker_index[m.get("ctx", "")] = m
                        except Exception:
                            pass
                ok = ok or bool(self.marker_index)
        except Exception:
            pass
        return ok

    def state_sentence(self, name="Nola"):
        top = "/".join(f"{e[0]} {e[1]:.2f}" for e in self.active_emotions[:3]) or "steady"
        lean = "leaning positive" if self.valence > 0.15 else ("low" if self.valence < -0.15 else "balanced")
        return (f"{name}'s internal state right now — valence {self.valence:+.2f} ({lean}), "
                f"arousal {self.arousal:.2f}; core emotions: {top}; "
                f"bond with Vaughn {self.bond_level:.2f} ({self.social_emotion}); "
                f"dials: {', '.join(n + ' ' + format(self.dials[i], '.2f') for i, n in enumerate(DIAL_NAMES))}. "
                f"Speak FROM this state and let it color tone naturally; if it conflicts, name it honestly.")


ENGINE = None


def get_engine(data_dir=None):
    """Lazy singleton; starts the decay-tick thread. Honesty layer ticks every 60s."""
    global ENGINE
    if ENGINE is None:
        d = data_dir or os.path.expanduser("~/voice-models/nola-emotion")
        ENGINE = EmotionEngine(d)
        ENGINE.load()
        def _tick_loop():
            while True:
                time.sleep(60)
                try:
                    with LOCK:
                        ENGINE.tick()
                        ENGINE.save()
                except Exception:
                    pass
        threading.Thread(target=_tick_loop, daemon=True).start()
    assert ENGINE is not None
    return ENGINE