const GV_MUSIC_TRACKS = [
  { id: 'default', title: 'Background Music', src: '../assets/musics/music.mp3' },
  { id: 'reading', title: 'Reading Music', src: '../assets/musics/reading-music.mp3' },
  { id: 'cosmic-study', title: 'Cosmic Study', src: '../assets/musics/the_mountain-cosmic-study-143288.mp3' },
  { id: 'geography-study', title: 'Geography Study', src: '../assets/musics/the_mountain-geography-study-141463.mp3' },
  { id: 'government-study', title: 'Government Study', src: '../assets/musics/the_mountain-government-study-142302.mp3' },
  { id: 'natural-study', title: 'Natural Study', src: '../assets/musics/the_mountain-natural-study-141476.mp3' },
  { id: 'space-study', title: 'Space Study', src: '../assets/musics/the_mountain-space-study-146969.mp3' },
  { id: 'study', title: 'Study', src: '../assets/musics/the_mountain-study-513400.mp3' },
  { id: 'study-rock', title: 'Study Rock', src: '../assets/musics/the_mountain-study-rock-136978.mp3' },
  { id: 'study-vibe', title: 'Study Vibe', src: '../assets/musics/the_mountain-study-vibe-136087.mp3' },
  { id: 'universe-study', title: 'Universe Study', src: '../assets/musics/the_mountain-universe-study-141461.mp3' }
];

const GV_DEFAULT_MUSIC_TRACK = GV_MUSIC_TRACKS[0];

function gvFindMusicTrack(trackId) {
  return GV_MUSIC_TRACKS.find(track => track.id === trackId) || GV_DEFAULT_MUSIC_TRACK;
}

window.GV_MUSIC_TRACKS = GV_MUSIC_TRACKS;
window.GV_DEFAULT_MUSIC_TRACK = GV_DEFAULT_MUSIC_TRACK;
window.gvFindMusicTrack = gvFindMusicTrack;
