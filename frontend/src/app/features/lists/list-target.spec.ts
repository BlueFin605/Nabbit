import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ApiClient } from '../../core/api/api-client';
import { DEFAULT_LIST_NAME, LAST_LIST_KEY, ListTarget } from './list-target';

const row = (id: string, name: string) => ({ id, name, itemCount: 0, version: 1, updatedAt: 'x' });

describe('ListTarget', () => {
  let listLists: jest.Mock;
  let createList: jest.Mock;
  let target: ListTarget;

  const setup = (rows: ReturnType<typeof row>[]) => {
    listLists = jest.fn().mockReturnValue(of(rows));
    createList = jest.fn().mockReturnValue(of({ id: 'new', name: DEFAULT_LIST_NAME, items: [], version: 1, updatedAt: 'x' }));
    TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: { listLists, createList } }] });
    target = TestBed.inject(ListTarget);
  };
  const resolved = () => {
    let out: unknown;
    target.resolve().subscribe((v) => (out = v));
    return out;
  };

  beforeEach(() => localStorage.clear());
  afterEach(() => jest.restoreAllMocks());

  it('picks the stored id when it still exists', () => {
    setup([row('l1', 'Shopping'), row('l2', 'Party')]);
    localStorage.setItem(LAST_LIST_KEY, 'l2');
    expect(resolved()).toEqual({ id: 'l2', name: 'Party' });
  });

  it('falls back to Shopping when the stored id is stale', () => {
    setup([row('l2', 'Party'), row('l1', 'Shopping')]);
    localStorage.setItem(LAST_LIST_KEY, 'gone');
    expect(resolved()).toEqual({ id: 'l1', name: 'Shopping' });
  });

  it('falls back to the first list when there is no Shopping', () => {
    setup([row('l2', 'Party'), row('l3', 'Other')]);
    expect(resolved()).toEqual({ id: 'l2', name: 'Party' });
  });

  it('creates Shopping on an empty account', () => {
    setup([]);
    expect(resolved()).toEqual({ id: 'new', name: 'Shopping' });
    expect(createList).toHaveBeenCalledWith('Shopping');
  });

  it('remember stores the id and readLast returns it', () => {
    setup([]);
    target.remember('l9');
    expect(localStorage.getItem(LAST_LIST_KEY)).toBe('l9');
    expect(target.readLast()).toBe('l9');
  });

  it('survives storage that throws', () => {
    setup([row('l1', 'Shopping')]);
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => target.remember('l1')).not.toThrow();
    expect(target.readLast()).toBeUndefined();
    expect(resolved()).toEqual({ id: 'l1', name: 'Shopping' });
  });
});
