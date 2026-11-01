# Write #9 — Emotional Detection Software

**Three voices on one technology: researcher, privacy watchdog, ethicist.**

A note on the premise before the paragraphs. The prompt says Spotify "has been granted a patent that knows when you are sad or mad," and that checks out — but the specifics matter. The patent is *"Identification of taste attributes from an audio signal,"* US10891948B2, assigned to Spotify AB, filed February 2018 and **granted January 12, 2021** [1][3]. Its claim recites "determining at least one of the emotional state, gender, age, or accent" [1]. The metadata it proposes to extract is explicitly broader than mood: a "content_metadata" object with `emotions`, `gender`, `age`, and `accents` fields — the accent example even carries a confidence score, `us:west-coast` at `0.71` [1]. It also extracts *environmental* metadata from background noise, categorizing "Physical Environment (i.e., Bus, Metro, Train, Outdoor, School, Coffee, Park...)" and "Social Environment (i.e., Alone, Small Group, Party...)" [4].

So: granted, yes. Deployed, no — and that gap is where the whole assignment lives. Spotify has said it does not intend to use the system and holds it as intellectual property [4].

---

## As a Researcher: The Potential Is Real, and It Is Not Marketing

Set aside the music-recommendation framing, which undersells the technology, and the capability is genuinely interesting. A system that infers emotional state, gender, age, and accent from an audio signal — while separately characterizing the acoustic environment — is a multimodal affect-classification problem, and solving it well would matter well beyond playlists.

The most defensible applications are in **accessibility and safety**. Emotion and stress detection from voice is the basis for tools that can flag escalating distress in a call with a crisis line, or detect cognitive load and fatigue in contexts where a lapse is dangerous. The patent itself gestures at a legitimate mechanism: it describes speaker classification using features such as "power spectrum density or frequency at maximum power," extracted by FFT and classified with neural networks [1]. That is straightforward signal processing, not magic — and the same pipeline that estimates accent or age can estimate vocal stress. A system that adapts to a user's apparent cognitive state has real uses in assistive interfaces: adjusting pacing, simplifying language, or offering support when a user sounds frustrated rather than making them fight the interface.

There is also a **research-tooling** argument. Large-scale affect data is scarce, expensive, and usually collected in labs with self-report instruments that are themselves unreliable. Continuous, in-the-wild estimation — if it were accurate and consented — would let researchers study emotional dynamics at a scale no questionnaire permits. And on the narrower point Spotify cares about: taste is genuinely contextual. A better model of *who you are, where you are, and who you are with* [4] produces recommendations that feel less like a slot machine.

The honest limits inside the research framing: the accuracy claims are the weakest link, and the patent is a claim, not a result. Classifying accent or gender by vocal features is comparatively tractable. *Emotion* is not, because emotion is not a property of an audio waveform — it is an inference about a person, and the ground truth is contested even among humans. Which is why the researcher's enthusiasm has to be disciplined by the watchdog's questions.

## As a Privacy Watchdog: This Is Intimacy Extraction at Industrial Scale

Four problems, in ascending order of severity.

**First, it is a listening microphone in your pocket.** The patent's inputs are explicitly broader than the user's own voice: environmental metadata can include "sounds from vehicles on a street, other people talking, birds chirping, printers printing" [4]. That means the *bystanders* in your car, café, or living room are analyzed without ever being users, consenting, or knowing. The unit of surveillance is not the individual; it is the room.

**Second, the classification taxonomy is itself the harm.** "Gender" and "accent" are not neutral descriptors here — they are features being extracted from a voice that may not match the speaker's identity, for downstream commercial use. An accent classifier outputting `us:west-coast: 0.71` [1] is, functionally, a demographic-profiling device operated without a legal basis. That is also why the EU treats biometric categorisation as a distinct harm rather than a sub-case of emotion detection — Article 5(1)(g) of the EU AI Act prohibits systems that categorize people by biometric data to infer sensitive characteristics, including "race, political opinions, trade union membership, religious or philosophical beliefs, sex life or sexual orientation" [5][6].

**Third, the manipulative use is the designed use — not an abuse of it.** This is the crux, and the patent is unusually candid about it. The Surveillance & Society study of these patents describes how an apparent display of care becomes a targeting channel: if a user sounds unwell, a system simulating solicitous attention — "would you like to order chicken soup?" — may be functioning "simply as a ruse to optimise and deliver a targeted ad or a suggestion to place a purchase order" [4]. The paper also notes the patent's own example that "targeted content may include sponsored content and third-party content" [4]. So the emotional read is not incidental to the business model. **The emotion *is* the product, and the empathy is the interface.**

**Fourth, the consent problem has no clean solution.** You cannot meaningfully consent to continuous ambient audio analysis, because the data is generated by other people who did not consent, and because the categories inferred (pregnancy, illness, intoxication, grief) are exactly the ones people least want inferred. Worse, these are *inferences about a state*, not statements by the user — and inferences are systematically harder to contest than facts, because the subject cannot prove what they were not feeling at a time they did not know they were being measured.

And the fourth problem scales with the fifth: the patent exists whether or not Spotify deploys it. The study's point is precise — Spotify's disavowal is telling because it "points to a horizon of acceptability," establishes that the idea is "commercially valuable," and notes that "even if Spotify does not pursue it, others will want to, and Spotify will still benefit from the sale of its asset" [4]. Patenting a capability is itself a form of deployment: it stakes the claim.

## As an Ethicist: Guidelines That Bite

I would propose six, ordered so the later ones do not quietly swallow the earlier ones.

**1. Prohibit emotion inference in workplace and education contexts outright.** Not regulate — prohibit. The EU AI Act already does exactly this: Article 5(1)(f) bans placing on the market, putting into service, or using AI systems "to infer emotions of a natural person in the areas of workplace and education institutions," with a narrow exception for medical or safety reasons [5][6]. It applies as of February 2, 2025 [7]. This is the right shape of rule because it targets the *context of asymmetric power*, not the accuracy of the model. An employer or a school grading your emotional state is a coercion problem regardless of F1 score.

**2. Prohibit biometric categorisation for sensitive traits, including by voice.** Article 5(1)(g) already covers inferring race, political opinion, religion, and sexual orientation from biometric data [5][6]. Voice-derived accent and gender classification should be treated as inside this prohibition, not adjacent to it. If a system infers a protected characteristic from a voiceprint, the inference is the harm — no downstream purpose redeems it.

**3. Transparency must be affirmative, contemporaneous, and revocable.** Where emotion recognition is lawful at all — outside work and school, as Article 5 leaves it [7] — the EU's Article 50 transparency duty is the floor: individuals must be informed they are being subject to emotion recognition [7]. I would go further: *inference at the point of analysis*, not a clause in a 40-page terms update. A notification that arrives at app install does not inform anyone of anything 18 months later.

**4. Bystanders have rights.** Any ambient-audio emotion system must be built so that non-users in the acoustic environment are not analyzed. Operationally this is hard, which is an argument against the ambient design, not a technical detail to be optimized away. If it cannot be built without profiling non-consenting people, it should not be built.

**5. No inferred-emotion targeting of advertising or price.** The emotional read may inform what the user sees about themselves; it may not be used to sell to them. This is the specific line the chicken-soup example crosses [4], and it is the reason to prohibit the practice rather than disclose it.

**6. Accuracy and contestability are obligations, not quality metrics.** Emotion is an inference, and contested ground truth is the norm. So a system must (a) report confidence and refuse low-confidence inferences rather than guessing, (b) never ground a consequential decision in an emotion estimate, and (c) give the subject a mechanism to contest an inference — including the right to have the *data deleted*, since an inference you cannot disprove is a permanent record you cannot correct.

**The through-line.** Guidelines 1–2 constrain the *context*; 3–4 constrain the *collection*; 5–6 constrain the *use*. A framework that only does the third — disclosure, consent, transparency — fails, because disclosure of a manipulative system does not make it non-manipulative. Consent is not the answer to an intimacy asymmetry; it is the paperwork that makes the asymmetry look settled.

---

## Sources

[1] https://patents.google.com/patent/US10891948B2/en — US10891948B2 — 'Identification of taste attributes from an audio signal', Spotify AB, granted 2021-01-12
[3] https://nypost.com/2021/01/29/spotify-making-algorithm-that-knows-when-youre-sad-angry — NY Post: Spotify algorithm that knows when you're sad or mad
[4] https://doi.org/10.24908/ss.v21i2.16015 — Surveillance & Society: 'Human-First, Please' — emotional AI in recommender systems, Spotify + Amazon patents
[5] https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-5 — EU AI Act Article 5 — prohibited practices: Art 5(1)(f) emotion recognition at work/education; Art 5(1)(g) biometric categorisation
[6] https://ai-act-service-desk.ec.europa.eu/sites/default/files/2026-01/guide-prohibited_en.pdf — European Commission Guidelines on Prohibited AI Practices (emotion recognition, biometric categorisation)
[7] https://www.euai-act.com/articles/prohibited-ai-practices — EU AI Act: prohibited practices — Art 50 transparency obligations for emotion recognition
