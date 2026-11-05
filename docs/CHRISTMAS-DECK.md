# The Christmas Deck

`content/packs/christmas.yaml`, pack id `christmas`, 87 questions, audience
35-75. Transcribed from a boxed card game, 'Tis The Season Christmas Trivia:
sixteen cards, six questions each, scanned front and back as
`christmas/c1.pdf`, `c2.pdf` and `c3.pdf` (the originals are untracked).

## Running a Christmas night

Under Questions, switch `The Christmas Deck` on and the adult sets off. Then
set **questions per round to 6**. The deck carries the six categories printed
on the box, and at six a round is exactly one card: one question from each
category, in the icon order that runs down the left edge of every card.

| Box category | Icon | Category id |
|---|---|---|
| History, Facts, and Figures | star | `xmas-history` |
| Traditions Around the World | candy cane | `xmas-traditions` |
| Cartoons, Animation, Made for Television Movies, Specials | tree | `xmas-animation` |
| Carols and Songs | log | `xmas-carols` |
| Movies on the Silver Screen | candle | `xmas-movies` |
| Literature and the Performing Arts | ornament | `xmas-stage` |

Left at the default ten questions a round, a mixed round asks four of the six
categories twice and the control screen says so. That still plays; six is just
the shape the deck was written in.

The six categories are in `content/categories.yaml` permanently. On an
ordinary night the pack filter empties them, so a mixed round never reaches
them.

## What is not a literal transcription

The cards were written for a person reading them aloud and judging the answer.
This is four buttons on a phone, so three things changed on every card:

- **Every answer gained three distractors.** None are on the cards; all were
  written here, to the rule in `docs/QUESTION-STYLE.md` that every option has
  to be defensible.
- **Every binary card gained two more options.** "Six or eighteen?" became
  Eighteen, Six, Twelve, Thirty. The card's answer is still the answer.
- **Every question gained a `fact`.** The cards carry no reveal line; the
  engine requires one. These were written here from what is publicly known
  about the film, song or custom in question.

Nothing above is recorded per question below. What follows is everything else.

## Cut (9 of 96)

Each is listed with the card text and the printed answer, so any of them can
be put back by writing it into the pack file.

1. **Card 3, candy cane.** "What is the average number of gifts an adult
   female receives for Christmas, 6 or 10?" — printed answer: 6. An unsourced
   statistic from the 1980s that nobody in the room can check or argue with.
2. **Card 6, star.** "Who was the smallest of the Magi?" — printed answer:
   Melchior. The Gospels do not say how many Magi there were, let alone their
   heights. Nothing to verify it against.
3. **Card 6, candy cane.** "Is the Swedish holiday dish lutfisk carp or
   herring?" — printed answer: Carp. **The card is wrong.** Lutfisk is dried
   cod or ling, soaked in lye. Carp is the Polish and Czech Christmas fish.
   Neither printed option is right, so the question cannot be rescued.
4. **Card 10, log.** "What carol contains the line 'Sing, choirs of angels,
   sing in exultation'?" — O Come, All Ye Faithful. The third question in the
   deck answering that carol.
5. **Card 11, log.** "After this song was translated from Latin, it did not
   rhyme and had unequal line lengths." — O Come, All Ye Faithful. A statement
   rather than a question, and the second of the three.
   Kept instead: card 9's "Come and behold Him, born the King of Angels".
6. **Card 12, log.** "What carol contains the line 'God and sinners
   reconciled'?" — Hark! The Herald Angels Sing. Same carol and same shape as
   card 15's "Glory to the newborn King", which is the better-known line.
   Card 15's is the one kept.
7. **Card 13, log.** "What is Santa's favorite Christmas carol?" — printed
   answer: "He loves all of them". A joke with no answer to put on a button.
8. **Card 13, ornament.** "In The Night Before Christmas, how many times does
   Santa whistle: two or four?" — printed answer: Two. The poem says only "he
   whistled, and shouted, and called them by name" and gives no count.
9. **Card 13, tree.** "On what network did Frosty the Snowman debut?" — CBS.
   Same answer and same wording as card 11's Charlie Brown network question;
   `npm run collide` flags them at 44% shared wording. Card 11's is kept.

Card 13 is down to three questions as a result. Nothing in the engine is
card-shaped, so this costs nothing but the symmetry.

## Rewritten (12)

The printed question is first, the pack's version second.

1. **xmas-004.** "What acronym carol did Eddy Arnold write?" → "What acronym
   carol did Eddy Arnold record, spelling the holiday out one letter at a
   time?" He recorded it; the writing credit is not his alone.
2. **xmas-015.** "What is my punishment cause I ain't been nuttin' but bad?" →
   "Which Christmas novelty song has the singer confessing 'I ain't been
   nuttin' but bad'?" The card only works if you already know it is a lyric.
3. **xmas-017.** "In The Night Before Christmas I sprang from my bed to see
   what?" → "In 'The Night Before Christmas,' the narrator springs from his bed
   to see what?" First person with no speaker named does not read on a screen.
4. **xmas-024.** "What Hallmark tradition is Louis Prang generally credited for
   popularizing in America?" → "Louis Prang is generally credited with
   popularizing what Christmas tradition in America?" Prang was printing cards
   decades before Hallmark existed; the card's wording invents a link.
5. **xmas-025.** "In what country does the mayor of Helsinki announce the start
   of Christmas?" → "In which Nordic country does a mayor publicly announce the
   start of Christmas each year?" The printed question answers itself.
6. **xmas-030.** "Name one of the three songs Burl Ives sang in Rudolph the
   Red-Nosed Reindeer." → "Which song did Burl Ives sing as the snowman
   narrator of Rudolph the Red-Nosed Reindeer?" Three correct answers cannot be
   three wrong buttons and one right one.
7. **xmas-039.** "In the novel, what do the reindeer in Central Park do when
   Kris Kringle visits?" → "In the Miracle on 34th Street novel, …" The card
   relies on the card above it naming the book.
8. **xmas-056.** "Who wrote A Holiday for Murder: Jane Marple or Agatha
   Christie?" → "Who wrote the Christmas mystery A Holiday for Murder?" Marple
   is a character in the books, not a candidate author.
9. **xmas-067.** "What garden doll was the trendy and popular toy of 1984?" →
   "What garden-themed doll was the must-have toy of the early 1980s?" The
   shortage and the fist fights were Christmas 1983.
10. **xmas-068.** "Traditionally, what carol will you hear most often at
    Christmas?" → "What Christmas song is the best-selling single of all time?"
    Most-heard is unmeasurable; best-selling is a matter of record, and the
    answer is the same.
11. **xmas-064.** "What ski-nosed comedian annually has a Christmas special on
    NBC?" → "…hosted an annual Christmas special on NBC?" Hope died in 2003.
12. **xmas-071.** "What do we call round or oval candies filled with fruit
    preserves, or cream and covered with chocolate?" → "What candies danced in
    the children's heads in 'The Night Before Christmas'?" The printed
    definition is the dictionary entry for a bonbon, not a sugarplum, so the
    card's own answer loses to one of its distractors. Reworded to the thing
    sugarplums are actually famous for.

## Hedged rather than cut (3)

Kept, with the doubt written into the `fact` so the MC is not caught out:

- **xmas-002**, the Urn of Fate in Spain. Italy keeps the same custom and is
  more usually named for it. The card's own "Iberian" is what makes the
  question answerable, so it stays in the prompt.
- **xmas-052**, Humphrey Bogart born December 25, 1899. The Christmas birthday
  was a studio line; some biographers argue for January. The fact says so.
- **xmas-070**, the sheep stolen from Farmer Hoggett on Christmas Day in Babe.
  The rustling is in the film; the date is the card's.

## Known collisions, accepted

`npm run collide` reports four inside the deck. All four are a question's
prompt containing a word that is another question's answer, and in each case
the second question's own prompt already contains that word, or the context is
different enough not to help:

- xmas-009's prompt names Bob Cratchit; xmas-033 asks "Scrooge or Cratchit?"
  and so names him too.
- xmas-059's prompt names A Charlie Brown Christmas; xmas-036 asks "Charlie
  Brown or Snoopy?".
- xmas-001's prompt says New Year's Day 1898; xmas-041 asks what Bulgaria's
  Nova Godina is.
- xmas-055's prompt names the film White Christmas; xmas-068 asks for the
  best-selling single.

Four more were real and were fixed before this was committed: xmas-009,
xmas-063, xmas-082 and xmas-087 each had a `fact` or prompt that said another
question's answer outright.

## Not yet done

- **No second-model fact-check.** `easy1` was checked by GPT-5 via Codex and by
  Claude Sonnet in a clean context. This deck has not been. The answers are the
  card's; the distractors and every `fact` line were written here and have had
  one pass by one model. `npm run fact-check` is the existing route.
- **The difficulty numbers are a first guess.** The deck skews hard: a lot of
  1940s pictures and television specials from the 1970s. Spread is roughly
  1:6, 2:33, 3:32, 4:16. A night in front of the room is the only real test.
- **The scans are untracked.** `christmas/*.pdf` and the photograph of the box
  are in the working tree but not in git, same as the screenshot rule: binaries
  in history are what put `.git` at 64MB.
