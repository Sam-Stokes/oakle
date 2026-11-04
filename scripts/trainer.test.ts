// The browser keeps one trainer for both games: a Yellow player opening Crystal must not be asked for a name again.
import {describe, expect, it} from 'vitest';
import {gameKey, ID_KEY, loadTrainer, type Stored} from '../src/trainer';

const store = (o: Record<string, Stored>) => (k: string) => o[k] ?? {};
const fresh = () => 'new-trainer';

describe('loadTrainer', () => {
  it('a Yellow player who opens Crystal keeps their id and name, with no Crystal runs yet', () => {
    const read = store({oakle: {id: 'abc', name: 'ASH', runs: {5: {done: true}}}});
    expect(loadTrainer(read, 'crystal', fresh)).toEqual({id: 'abc', name: 'ASH', runs: {}});
  });
  it('and their Yellow save is read exactly as before', () => {
    const read = store({oakle: {id: 'abc', name: 'ASH', runs: {5: {done: true}}}});
    expect(loadTrainer(read, 'yellow', fresh)).toEqual({id: 'abc', name: 'ASH', runs: {5: {done: true}}});
  });
  it('a new visitor gets a new trainer with no name', () => {
    expect(loadTrainer(store({}), 'crystal', fresh)).toEqual({id: 'new-trainer', name: '', runs: {}});
  });
  it('a name picked on Crystal first is the name on Yellow too', () => {
    const read = store({[ID_KEY]: {id: 'zed', name: 'MISTY'}, [gameKey('crystal')]: {id: 'zed', name: 'MISTY', runs: {1: {done: true}}}});
    expect(loadTrainer(read, 'yellow', fresh)).toEqual({id: 'zed', name: 'MISTY', runs: {}});
    expect(loadTrainer(read, 'crystal', fresh).runs).toEqual({1: {done: true}});
  });
  it('after the trainer changes on one game (a pairing code), the other game drops its runs for the server to refill', () => {
    const read = store({[ID_KEY]: {id: 'new', name: 'GARY'}, oakle: {id: 'old', name: 'ASH', runs: {5: {done: true}}}});
    expect(loadTrainer(read, 'yellow', fresh)).toEqual({id: 'new', name: 'GARY', runs: {}});
  });
});
