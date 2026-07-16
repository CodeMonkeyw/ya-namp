/** Bootstrap: create the audio engine and hand it to the UI layer. */
import './style.css';
import { Player } from './player';
import { initUI } from './ui';

initUI(new Player());
