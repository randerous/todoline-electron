import { describe, expect, it } from 'vitest';
import { searchMatches, searchPattern, searchTest } from '../src/shared/search';

const ranges=(text:string,query:string,options={})=>searchMatches(text,searchPattern(query,options)!);

describe('search matching', () => {
  it('ignores case unless asked and keeps every occurrence', () => {
    expect(ranges('Todo todo TODO','todo')).toEqual([[0,4],[5,9],[10,14]]);
    expect(ranges('Todo todo TODO','todo',{caseSensitive:true})).toEqual([[5,9]]);
  });
  it('treats regular expression characters as literal text', () => {
    expect(ranges('a.c abc','a.c')).toEqual([[0,3]]);
    expect(searchTest('abc',searchPattern('a.c')!)).toBe(false);
  });
  it('whole word ignores matches glued to letters, digits or Han characters', () => {
    expect(ranges('do dot undo do-it','do',{wholeWord:true})).toEqual([[0,2],[12,14]]);
    expect(ranges('事件 事件列表','事件',{wholeWord:true})).toEqual([[0,2]]);
    expect(ranges('事件 事件列表','事件')).toEqual([[0,2],[3,5]]);
  });
  it('matches Chinese, keeps no cursor between calls and refuses empty queries', () => {
    const pattern=searchPattern('截止')!;
    expect(searchTest('截止时间 截止',pattern)).toBe(true);
    expect(searchTest('截止时间 截止',pattern)).toBe(true);
    expect(searchMatches('截止时间 截止',pattern)).toEqual([[0,2],[5,7]]);
    expect(searchPattern('   ')).toBeNull();
    expect(searchPattern('')).toBeNull();
  });
});
