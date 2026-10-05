const assert = require('node:assert/strict')
const {
  parseTraceMoeFilename,
  formatTraceMoeTime,
  traceMoeSceneDescription,
  traceMoeTagCandidates,
  pickDanbooruCopyright,
} = require('./trace-moe-core.js')

const scene = parseTraceMoeFilename('Even.the.Student.Council.Has.Its.Holes.S01E01.720p.UNCENSORED.OV.WEB-DL.ENG.AAC2.0.H.264.ESub-ToonsHub.mkv')
assert.equal(scene.title, 'Even the Student Council Has Its Holes')
assert.equal(scene.season, 1)
assert.equal(scene.episode, 1)

const fansub = parseTraceMoeFilename('[SubsPlease] Seitokai ni mo Ana wa Aru! - 05 (1080p) [ABCD1234].mkv')
assert.equal(fansub.title, 'Seitokai ni mo Ana wa Aru!')
assert.equal(fansub.season, null)
assert.equal(fansub.episode, 5)

const seasonFansub = parseTraceMoeFilename('[Erai-raws] Some Show S2 - 11 [1080p].mkv')
assert.equal(seasonFansub.season, 2)
assert.equal(seasonFansub.episode, 11)
assert.equal(seasonFansub.title, 'Some Show')

const words = parseTraceMoeFilename('Show Name Season 3 Episode 12.mp4')
assert.equal(words.season, 3)
assert.equal(words.episode, 12)

assert.deepEqual(parseTraceMoeFilename('random_clip.mp4'), { filename: 'random_clip.mp4', title: '', season: null, episode: null })

assert.equal(formatTraceMoeTime(572.667), '00:09:32')
assert.equal(formatTraceMoeTime(1420.084), '00:23:40')
assert.equal(formatTraceMoeTime(null), '')

const described = traceMoeSceneDescription({ ...scene, start: 572.667, end: 574.292, duration: 1420.084 })
assert.equal(
  described.description,
  'Even the Student Council Has Its Holes — Season 1, Episode 1, at 00:09:32–00:09:34 of 00:23:40. '
    + 'Source file: Even.the.Student.Council.Has.Its.Holes.S01E01.720p.UNCENSORED.OV.WEB-DL.ENG.AAC2.0.H.264.ESub-ToonsHub.mkv',
)
assert.deepEqual(described.tags, ['season_1', 'episode_1', 's01e01'])
assert.deepEqual(traceMoeSceneDescription({ ...fansub }).tags, ['episode_5'])

// Native-script titles are dropped, fullwidth punctuation folds, dupes collapse.
assert.deepEqual(
  traceMoeTagCandidates(['生徒会にも穴はある！', 'Seitokai ni mo Ana wa Aru！', 'Even the Student Council Has Its Holes!', '學生會也有洞！', 'seitokai ni mo ana wa aru!', '']),
  ['seitokai_ni_mo_ana_wa_aru!', 'even_the_student_council_has_its_holes!'],
)
assert.deepEqual(traceMoeTagCandidates(['K-ON!', 'x']), ['k-on!'])

// Alias stubs (0 posts) and non-copyright tags never win; the most-posted does.
assert.equal(pickDanbooruCopyright([
  { name: 'even_the_student_council_has_its_holes!', category: 3, post_count: 0 },
  { name: 'seitokai_ni_mo_ana_wa_aru!', category: 3, post_count: 1070 },
  { name: 'seitokai_ni_mo_ana_wa_aru!self-upload', category: 0, post_count: 50 },
]), 'seitokai_ni_mo_ana_wa_aru!')
assert.equal(pickDanbooruCopyright([{ name: 'old', category: 3, post_count: 9, is_deprecated: true }]), '')
assert.equal(pickDanbooruCopyright(null), '')

console.log('trace-moe-core tests passed')
