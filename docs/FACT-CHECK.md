# Fact-check findings

An audit of the question bank by web research, one researcher per category,
each checking three things per question: is the marked answer correct, is
exactly one option defensible, and is the `fact:` sentence accurate.

**Nothing in this file has been applied.** Each entry is a decision for a human.

## Coverage: two tiers, and the difference matters

The session's web-search budget is 200 calls shared by every researcher, and it
ran out partway through. So this report has two kinds of category.

**Web-verified** — searched against live sources, citations in the findings:
medicine, invention-tech, natural-world, history-20c, physics-chemistry,
space-aviation, american-history, explorers, military-history, world-history,
literature, us-places, words-language, food-drink, sports, business-economics,
film-tv. 17 categories, 502 questions.

**Not properly searched** — geography (19 searches then dry), world-affairs
(2), transportation (2), stage-musicals (3), and everything run after them.

For the second tier, **the findings are probably sound but the clean counts are
not**. A flagged item carries a citation and can be checked. An unflagged item
in those categories mostly was not looked up, so "clean" there means "nothing
the model already knew contradicted it", which is a much weaker claim and is
the same kind of check the built-in verifier already performs.

Re-run the second tier against live sources before trusting its clean counts.
`tiebreakers` is the priority: fifteen numeric answers that decide a night
outright.

## The pattern

Almost every error found is in the `fact:` sentence, not the answer. The
answers have been checked by somebody at some point; the embellishment
appended afterwards never was. The fun fact is also the part read aloud to the
room, so it is the part most likely to be challenged.

The second pattern is confident repetition of a popular myth — a claim that is
widely believed, sounds like a good piece of trivia, and is a misreading of
something real. `inv-007` is the type specimen.

## Status

| Category | Checked | Clean | Flagged |
|---|---:|---:|---:|
| medicine | 25 | 24 | 1 |
| invention-tech | 32 | 29 | 3 |
| natural-world | 26 | 24 | 2 |
| history-20c | 30 | 27 | 3 |
| physics-chemistry | 25 | 23 | 2 |
| space-aviation | 32 | 30 | 2 |
| american-history | 25 | 22 | 3 |
| explorers | 25 | 20 | 5 |
| military-history | 39 | 35 | 4 |
| world-history | 25 | 19 | 6 |
| literature | 30 | 29 | 1 |
| us-places | 34 | 31 | 3 |
| words-language | 40 | 32 | 8 |
| food-drink | 40 | 35 | 5 |
| sports | 39 | 34 | 5 |
| business-economics | 35 | 31 | 4 |
| film-tv | 38 | 33 | 5 |
| geography | 40 | 35 | 5 · partially searched |
| world-affairs | 30 | 28 | 2 · barely searched |
| transportation | 25 | 21 | 4 · barely searched |
| stage-musicals | 25 | 23 | 2 · barely searched |
| tiebreakers | 15 | 13 | 2 · **one wrong answer** |
| arts-classical | 30 | 25 | 5 · barely searched |
| music-popular | 30 | 23 | 7 · barely searched |

---

## FACT-ERROR — the stated fact is false

### `inv-007` — "A US court upheld Tesla's radio patents decades afterwards"

The famous myth. *Marconi Wireless Telegraph Co. of America v. United States*
(320 U.S. 1, 1943) invalidated one later Marconi **tuning** patent on prior art
by Oliver Lodge and John Stone Stone. It did not adjudicate Tesla's patents and
expressly left Marconi's priority for the first transmission standing.

Worse: Tesla is a **distractor in this very question**, so the question says
"not Tesla" and the fact then says a court sided with him. Tesla is the subject
people are most passionate about.

**Fix:** drop the clause, or say the 1943 ruling struck down a later Marconi
tuning patent on Lodge and Stone's prior work.

### `med-021` — the anvil is in the middle ear, not the inner ear

Prompt reads "Which bone of the **inner** ear is also known as the anvil?" The
malleus, incus and stapes are **middle** ear ossicles; the inner ear has no
bones. Sharpened by the distractor list offering "The cochlea", which genuinely
is an inner-ear structure.

**Fix:** one word, `inner` → `middle`. Answer and fact are otherwise correct.

### `h20-007` — Black Monday was the worse day, not Black Tuesday

Fact says "The worse day came the following Tuesday, 29 October, when the Dow
lost roughly 12 per cent." Monday 28 October lost about 13 per cent; Tuesday 29
October about 12.

**Fix:** name Monday 28 October as the worst day and keep Tuesday as the second.
Source: Federal Reserve History, Stock Market Crash of 1929.

### `h20-023` — Sweden and Spain were neutral in both wars

Fact says "Sweden, Spain and Portugal were also neutral in the second war, but
not in both." Sweden declared neutrality in August 1914 and held it; Spain was
neutral 1914–18. Only Portugal fits, having entered the First World War in 1916.

**Fix:** "Sweden and Spain were neutral in both; Portugal was neutral in the
second but fought in the first from 1916."

### `h20-003` — Brown did not explicitly overturn Plessy

Fact says the 1954 ruling "explicitly overturned" Plessy. The opinion confined
itself to holding that separate but equal "has no place" in public education
and never formally overruled the 1896 decision.

**Fix:** "gutted the doctrine Plessy had established in 1896" rather than
"explicitly overturned". Lower severity, but a retired lawyer will catch it.

### `inv-021` — the calotype is 1840–41, not 1839

Fact says "Talbot's calotype arrived the same year" as the 1839 daguerreotype.
Talbot's 1839 process was photogenic drawing; the calotype dates to September
1840, patented February 1841. The calotype is also a distractor in this
question, so the fact contradicts the question's own framing.

**Fix:** "Talbot's paper negatives arrived the same year", or move the calotype
to 1841.

### `inv-006` — the MIT Radiation Laboratory did not exist in 1947

Fact says "Every one of the wrong answers was a serious rival lab at the time"
of the 1947 transistor. The Rad Lab closed 31 December 1945; its successor was
the Research Laboratory of Electronics. RCA and GE were genuine rivals.

**Fix:** drop the sweeping sentence, or swap the distractor for a lab that
existed in 1947.

### `phy-019` — Scheele made oxygen before Priestley published

Fact says "Priestley isolated oxygen first". Priestley **published** first
(1774); Scheele produced it in 1771 and published in 1777. Genuinely shared
priority.

**Fix:** "Priestley published first, though Scheele had made the gas three
years earlier."

### `phy-007` — the pH scale is not bounded at 0 and 14

Fact asserts the scale "runs from 0 to 14". That is a teaching convention from
water at 25 °C, not a limit; concentrated acids and bases measure outside it.

**Fix:** "usually runs from 0 to 14". Low severity.

---

## ARGUABLE — a distractor can also be defended

### `nat-026` — potassium is a defensible answer

"Which element do plants draw from the soil in the greatest quantity?" →
Nitrogen, with **Potassium** offered as a distractor. Potassium uptake exceeds
nitrogen in many crops; potato takes up roughly 50 per cent more K than N. In a
room with serious gardeners this gets challenged.

**Fix:** swap potassium out for a safer distractor. The question's real teaching
point is the fun fact about carbon coming from the air, which is unaffected.

### `nat-015` — Richter measures magnitude, not energy

"Which scale measures the **energy released** by an earthquake?" Richter is a
magnitude scale from wave amplitude and saturates above about M6.5; moment
magnitude replaced it for large quakes. The fact reinforces the error by
contrasting Mercalli as rating damage "rather than the energy".

**Fix:** "Which scale measures the magnitude of an earthquake?" No distractor
becomes more defensible.

### `amh-003` — "freed nobody the Union actually controlled"

A well-known myth. The Emancipation Proclamation exempted only enumerated
areas (all of Tennessee, 13 Louisiana parishes, 48 Virginia counties).
Union-occupied regions that were *not* exempted — the South Carolina Sea
Islands, coastal North Carolina, parts of Florida, Mississippi and Arkansas —
were covered, and an estimated 20,000–50,000 people were freed on 1 January
1863.

**Fix:** it did not touch slavery in the loyal border states, and it did
immediately free tens of thousands in occupied Confederate territory.

### `amh-023` — "the Supreme Court ruled for the Cherokee and Jackson ignored it"

The Worcester v. Georgia myth, resting on an apocryphal quotation first printed
by Horace Greeley in 1864, two decades after Jackson's death. Neither Jackson
nor the federal government was a party; the ruling voided a Georgia criminal
statute, Georgia defied it, and Jackson had no occasion to enforce it. He later
pressed Georgia's governor to release Worcester.

Also: the Long Walk was 1864, twenty-six years after 1838, not twenty-five.

**Fix:** "Georgia defied the ruling while Jackson declined to intervene."

### `exp-025` — "All four died on African expeditions"

False. James Bruce returned from Abyssinia and died at home at Kinnaird,
Stirlingshire, on 27 April 1794, after falling down his own staircase.
Clapperton died at Sokoto in 1827 and Laing near Timbuktu in 1826, so three of
the four, not all.

**Fix:** name Bruce as the one who came home. The staircase is a better piece
of trivia than the false generalisation it replaces.

### `exp-024` — the Powell expedition count mixes baselines

"Set out with nine men… came out with six" uses different baselines. The party
was ten men in four boats (Powell plus nine) and emerged with six men and two
boats, that six *including* Powell. As read aloud it overstates the survivors.

**Fix:** "He set out with ten men and four boats and came out with six men and
two."

### `exp-019` — Zheng He's records were suppressed, not burned

"The records burned" is a popular embellishment. The voyage archives were
suppressed, withheld and lost over the decades after 1433.

**Fix:** "halted by imperial decree, and most of the official records
suppressed and lost."

### `amh-004` — the Louisiana Purchase was about three cents an acre

$15 million for roughly 530 million acres is about 2.8 cents. Every standard
source says "about three cents an acre"; the fact says four.

### `spa-008` — the Tu-144 beat Concorde by 26 days, not two months

Tu-144 first scheduled service 26 December 1975 (mail and freight only);
Concorde 21 January 1976. Also, because the Tu-144 carried no fare-paying
passengers until November 1977, the **Concorde distractor is defensible** to
anyone reading "commercial service" as passenger service — Guinness credits
Concorde as the first supersonic airliner in passenger service.

**Fix:** correct the gap and tighten the prompt to "revenue service of any
kind".

---

## ARGUABLE — continued

### `spa-027` — two options are literally correct

"Which Soviet space station preceded the International Space Station?" Salyut 1
and the Almaz stations also preceded it. Only Mir was the *immediate*
predecessor.

**Fix:** "…was the immediate predecessor of the ISS?"

### `exp-023` — Pinzón reached Brazil before Cabral

Vicente Yáñez Pinzón made landfall on the Brazilian coast about 26 January
1500, roughly three months before Cabral on 22 April. Some Brazilian
municipalities teach Pinzón as the discoverer.

**Fix:** name Cabral as the first Portuguese commander to sight Brazil and
claim it for Portugal.

### `exp-013` — Polynesian contact with South America is now contested

The fact's closing "most scholars still think they did not" is no longer safe.
A 2020 *Nature* study found Native American gene flow into eastern Polynesia
around AD 1200, though ancient Rapa Nui DNA is used to dispute it.

**Fix:** scholars reject Heyerdahl's claim that Polynesia was *settled* from
South America, while 2020 genetic evidence does point to some contact.

### `mil-002` — Midway did not cost Japan most of its aircrew

"Along with most of their experienced aircrew" is the long-standing myth
corrected by Parshall and Tully's *Shattered Sword*. Japan lost roughly 110
carrier aviators out of about 2,000; over three-quarters of the airmen aboard
the four carriers were rescued. What was irreplaceable was the carriers and
their trained maintenance crews.

### `mil-034` — Churchill was removed from the Admiralty, not resigned

He was forced out on 24–25 May 1915 as the Conservatives' price for joining
Asquith's coalition and demoted to Chancellor of the Duchy of Lancaster. He
resigned from the government in November 1915, after being left off the new
War Committee.

### `mil-001` — the arithmetic contradicts itself

Husky landings 9–10 July 1943, Mussolini deposed 25 July: 15–16 days, not
"within two weeks". The date is given in the same sentence, so a listener can
do the subtraction while it is being read.

### `mil-022` — the Red Tails were painted on P-47s first

The 332nd's red tail markings were applied to their P-47 Thunderbolts in spring
1944 and carried over to the Mustangs. The fact has it the other way round,
which also makes the "P-47 Thunderbolt" distractor partly defensible.

### `wld-012` — Tordesillas was not papal-brokered

The 1494 line was a bilateral Spanish–Portuguese treaty that moved the pope's
1493 line (*Inter caetera*) 370 leagues west precisely because Portugal
rejected it. Papal confirmation came in 1506.

### `wld-021` — "Paris is worth a mass" is apocryphal

Not recorded in Henry IV's lifetime; attached to him later. His 1593 conversion
and its political motive are solid; the quotation is not.

### `wld-009` — Stamford Bridge to Hastings is about 200 miles

Conventionally about 200, not 250. The forced-march story itself has also been
challenged in recent scholarship, so the embellishment is best dropped.

---

## ARGUABLE — continued (world history)

- **`wld-002`** — the Antonine Wall is also a Roman wall across northern
  Britain, and the fact sentence concedes it ("The Antonine Wall is also
  real"). Two options are defensible. Disambiguate the prompt.
- **`wld-018`** — Theodosius II genuinely had Roman law codified (the *Codex
  Theodosianus*, 429–438) and reigned from Constantinople. Name the *Corpus
  Juris Civilis* in the prompt.
- **`wld-001`** — the Ottoman Empire was also ruled from Constantinople, and
  1453 is after Rome fell. Tighten to "carried on the Roman state".

---

## WRONG — the keyed answer is not correct

### `tie-010` — Niagara Falls is 188 feet, not 170 — and it is a tiebreaker

Verified directly against Niagara Parks, the official operator: the Horseshoe
Falls "drops an average of 57 metres (188 ft.) into the Lower Niagara River".
The stored `answerNumber` is 170.

This is the worst finding in the audit, because of what a tiebreaker is.
Closest guess wins, so a player who looks the falls up and answers 188 is
eighteen feet out, while a player who guesses 170 scores exactly. **The
question punishes the person who knows the answer, and it decides the night.**

170 is close to the drop measured to the *surface* of the plunge pool, which is
itself about 100 ft deep — so the number is not invented, it answers a
different question from the one asked.

**Fix:** `answerNumber: 190` (nearest ten feet; 188 actual) and the fact to
match. If the plunge-pool measurement is wanted, the prompt has to say so.

Source: https://www.niagaraparks.com/visit-niagara-parks/plan-your-visit/niagara-falls-geology-facts-figures/

### `tie-007` — "to the nearest ten miles" is precision the question cannot carry

New York to Los Angeles by air ranges from about 2,437 miles (Newark to
downtown LA) through 2,446 (centre to centre) to 2,470 (JFK to LAX). The
ten-mile bucket depends entirely on endpoints the prompt never states, and air
distances are often quoted in nautical miles.

**Fix:** either name the endpoints, or drop to "roughly how many miles".


### `wrd-022` — the answer should be Aegis, not Escutcheon

"Which word originally meant a small shield, and now means a protective
barrier?" keyed to **Escutcheon**. An escutcheon never meant a small shield: it
is the heraldic shield of a coat of arms, from Latin *scutum*, the **large**
Roman shield, or a keyhole plate. **Aegis** is the word that originally named a
shield (Zeus's) and now means protection. **Bulwark**, also offered as a
distractor, literally means a protective barrier.

So two of the distractors beat the keyed answer. This is the only question in
502 checked where the answer itself is wrong.

**Fix:** answer Aegis, prompt reworded to "originally the shield of Zeus, and
now means protection or sponsorship".

---

## More fact errors

- **`biz-003`** — the Five-Dollar Day "so workers could buy the cars" is the
  classic myth. Ford's 1914 justification was profit sharing and ruinous labour
  turnover; 14,000 workers were trivial against 170,000 annual sales. It also
  doubled *Ford's own* minimum, not prevailing wages.
- **`spo-017`** — the 1980 Miracle on Ice was not a semi-final. The USSR game
  was the first game of a four-team medal round-robin, and the US still needed
  to beat Finland for gold.
- **`spo-035`** — not every winning player is engraved on the Stanley Cup;
  eligibility requires 41 regular-season games or a Cup Final appearance, and
  the team is capped around 52 names.
- **`usp-007`** — Tennessee seceded in June 1861 and was the last state to join
  the Confederacy, so it was not a slave state that "stayed in the Union".
- **`usp-012`** — Baltimore hosted the Continental Congress in the winter of
  1776–77, not "at some point in the 1780s".
- **`usp-033`** — Wyoming is the 10th largest state by area, not the ninth.
  Oregon is ninth.
- **`fnd-006`** — crémant is a protected term limited to eight appellations,
  not the general French name for traditional-method sparkling wine.
- **`fnd-033`** — over-muddled mint turns bitter from chlorophyll in torn
  leaves, not "from the stems".
- **`wrd-032`** — the "ect." misspelling coming from hearing "ex-cetera" is an
  unsupported folk explanation.
- **`wrd-033`** — "homonyms are spelled alike" describes **homographs**.
  Homonyms are both spelled and pronounced alike.
- **`wrd-034`** — "admiral" does not carry the Arabic article; it is from
  *amir*, commander, with its ending acquired through Latin and French.
- **`wrd-037`** — the comma splice is not "the most-corrected error in
  English"; in the standard research spelling dominates and the splice ranks
  around eighth.

## More arguables

- **`wrd-001`** — "the **only** English word that is its own opposite" is
  contradicted by its own fact sentence, which names *sanction* and *table*.
  Contronyms are a large class. Drop "only".
- **`wrd-008`** — "billowy" and "abhors" are also alphabetical, so two
  distractors are defensible against "almost".
- **`wrd-028`** — only *tea* is securely Chinese; *typhoon* is a convergence of
  Greek and Arabic reaching English via Portuguese.
- **`fnd-039`** — **duplicates `fnd-014`**: same bourbon 51%-corn point, same
  answer, near-identical fact. The near-dupe checker missed it because the
  prompts differ. Read aloud in one night, the room notices.
- **`fnd-015`** — croissant: Austria gave the kipferl, but the laminated
  croissant is French, c. 1905–15, so the fact also misdates the refinement.
- **`fnd-028`** — "lees" is the fermentation deposit, not the sediment an aged
  bottle throws.
- **`spo-016`** — 26 miles 385 yards was the 1908 London course; it became the
  standard only in 1921.
- **`spo-026`** — the Breeders' Cup Classic has run at Churchill Downs nine
  times, so that distractor is defensible.
- **`spo-038`** — "a nought" is also correct cricket usage for zero, and the
  bank's own `spo-018` fact uses that phrasing.
- **`biz-007`** — American Tobacco was also broken up in 1911, two weeks after
  Standard Oil, and the fact sentence admits it.
- **`biz-020`** — Total Quality Management is also Japanese-developed, and the
  fact credits Deming with influencing both.
- **`biz-028`** — "The Big Board" is not from the NYSE's address; it is from
  the quotation board on the floor. "The Street" is the address nickname.

### `ftv-023` — the Godfather line is misquoted in the prompt

The prompt asks about "I'm **going to** make him an offer he can't refuse."
Vito Corleone says "I'm **gonna**", which is also the exact wording AFI ranked
second in its 100 Movie Quotes. Misquotation is the classic film-trivia trap
and this audience knows the line.

### `ftv-033` — fifteen minutes of dinosaur, six of CGI

The fact conflates total dinosaur screen time with computer animation. Jurassic
Park has about fifteen minutes of dinosaur footage, of which roughly six is
CGI; about nine is Stan Winston's animatronics.

### `ftv-019` — Kwai is not "well over three hours"

*The Bridge on the River Kwai* runs 161 minutes. Only *Lawrence of Arabia*
(222 minutes) exceeds three hours.

### `ftv-035` — Cheers finished 74th of 77, not last

"Nearly cancelled" is right; "finished last" is not.

### `ftv-022` — the Stivics are weakly defensible (arguable)

Mike and Gloria Stivic are half the four-person main cast of *All in the
Family* and Gloria got her own spin-off. Swap the distractor.

### `geo-015` — Angel Falls: 979 m total, 807 m uninterrupted

The prompt asks for the highest **uninterrupted** waterfall and the fact then
gives 979 m, which is the total height including about 400 m of sloped cascade
and a separate 30 m plunge below the main fall. The uninterrupted plunge is
807 m, so the question and its own fact measure different things.

### `geo-008` — Istanbul is not the only major city on two continents

There are at least five transcontinental cities: Istanbul plus Suez, Orenburg,
Magnitogorsk and Atyrau. Say "by far the largest of the handful".

## More arguables

- **`geo-034`** — Liberia, offered as a distractor, is conventionally the
  *other* African country never colonised by a European power. As worded, it is
  at least as correct as Ethiopia. The fact's "never established colonial rule"
  is also loose: Italy formally annexed Ethiopia into Italian East Africa.
- **`geo-040`** — Egypt, a distractor, is commonly counted as bordering both
  the Atlantic (via the Mediterranean) and the Indian Ocean (via the Red Sea).
  "Only country" does not survive an argumentative room.
- **`geo-030`** — Hawaii is no longer the only state growing coffee
  commercially; California has roughly 70 farms. The fact silently rewrites the
  prompt to "only long-standing producer", which is a different claim.

## Findings from the barely-searched categories

Treat these as leads with citations, not as a completed audit of their file.

- **`trn-004`** — Diesel's first engine ran on petroleum, not peanut oil; the
  peanut-oil engine was shown by the French Otto company at the 1900 Paris
  Exposition. He also vanished on a North Sea crossing, not the Channel.
- **`trn-007`** — "laid up for decades" is stale: the SS United States was
  towed from Philadelphia in February 2025 and is in Mobile awaiting sinking as
  an artificial reef off Florida. The crossing time quoted is the eastbound one.
- **`trn-014`** — Budapest's Line 1 (1896) was the first *electrified*
  underground on the European mainland; Istanbul's Tünel opened in 1875.
- **`trn-017`** — "John Henry probably never existed" states as settled a
  question historians treat as open; Scott Reynolds Nelson's archival work
  identifies a candidate.
- **`wor-007`** — the Iron Curtain was not Churchill's coinage; it predates him
  and he popularised it at Fulton in 1946.
- **`wor-012`** — the Suez Canal company was French-founded, not Anglo-French
  from its 1869 opening; Britain bought the Khedive's stake in 1875.
- **`stg-007`** — Sondheim called Sweeney Todd a "dark operetta", not a "black
  operetta", and said the label fits no better than any other.
- **`stg-005`** — the Drama Desk Awards also honour Broadway, so two options
  answer the prompt. Another case of the fact sentence skipping the distractor
  that is a genuine second answer.

### Arts and music (fetched, not searched — leads with citations)

- **`art-003`** — Picasso's condition for Guernica going to Spain was the
  restoration of public liberties and democratic institutions, not Franco's
  death. That is why it stayed at MoMA until 1981, six years after he died.
- **`art-004`** — the Guggenheim was not Wright's last major commission; he
  took the Marin County Civic Center in 1957. It was his last major *completed*
  building.
- **`art-017`** — the Venus de Milo has not been "in Paris ever since": moved
  during the 1870 Commune, evacuated in both wars, and shown in Japan in 1964.
- **`art-020`** — Solti's 31 Grammys are no longer the record (Beyoncé passed
  him in 2023), and Reiner was not his predecessor at Chicago — Martinon was.
- **`art-026`** — "less is more" is Browning, from *Andrea del Sarto* (1855).
  Mies took it as a motto; he did not coin it.
- **`mus-018`** — "A Boy Named Sue" was never a number one pop hit. It reached
  No. 2 on the Hot 100, blocked by "Honky Tonk Women", and No. 1 country. Cash
  never had a Hot 100 number one.
- **`mus-009`** — the fact implies Dark Side's chart record has since been
  broken. It still stands. The famous run was 736 weeks; re-entries since 2009
  take it near 1,000.
- **`mus-019`** — Simon and Garfunkel split the same year as *Bridge over
  Troubled Water* (1970), not the year after.
- **`mus-025`** — a third authenticated photograph of Robert Johnson was
  published in 2020, so "only two" is out of date.
- **`mus-005`** — "Good Vibrations" took about seven months, not six.
- **`mus-029`** — Ben E. King is a credited co-writer of "Stand By Me"; Stoller
  put him at 50 per cent.
- **`mus-002`** — the Beatles *are* pictured on the Sgt. Pepper cover, so the
  prompt's premise is shaky, and Revolver's collage makes that distractor
  defensible too.
