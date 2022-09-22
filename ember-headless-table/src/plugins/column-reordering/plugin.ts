import { cached, tracked } from '@glimmer/tracking';
import { assert } from '@ember/debug';
import { action } from '@ember/object';

import { TrackedMap } from 'tracked-built-ins';

import { BasePlugin, meta } from '../-private/base';

import type { Plugin } from '[public-plugin-types]';
import type { Column, Table } from '[public-types]';

export interface ColumnOptions {}
export interface TableOptions {}

export class ColumnReordering
  extends BasePlugin<ColumnMeta, TableMeta, TableOptions, ColumnOptions>
  implements Plugin<ColumnMeta, TableMeta>
{
  name = 'column-reordering';
  static features = ['columnOrder'];
  static requires = ['columnVisibility'];

  meta = {
    column: ColumnMeta,
    table: TableMeta,
  } as const;

  reset() {
    let meta = this.getTableMeta();

    meta.reset();
  }
}

class ColumnMeta {
  constructor(private column: Column) {}

  get #tableMeta() {
    return meta.forTable(this.column.table, ColumnReordering);
  }

  get position() {
    return this.#tableMeta.getPosition(this.column);
  }

  set position(value: number) {
    this.#tableMeta.setPosition(this.column, value);
  }

  /**
   * Move the column one spot to the left
   */
  moveLeft = () => this.position--;

  /**
   * Move the column one spot to the right
   */
  moveRight = () => this.position++;
}

class TableMeta {
  constructor(private table: Table) {}

  /**
   * We want to maintain the instance of this ColumnOrder class because
   * we allow the consumer of the table to swap out columns at any time.
   * When they do this, we want to maintain the order of the table, best we can.
   * This is also why the order of the columns is maintained via column key
   */
  #columnOrder = new ColumnOrder({ columns: () => this.#visibleColumns });

  @action
  getPosition(column: Column) {
    return this.#columnOrder.get(column.key);
  }

  @action
  setPosition(column: Column, newPosition: number) {
    return this.#columnOrder.set(column.key, newPosition);
  }

  /**
   * Revert to default config, ignoring preferences
   */
  @action
  reset() {
    // TODO: delete relevant preferences entries.
    //       do we also want to clear local state?
  }

  get columns() {
    return this.#columnOrder.orderedColumns;
  }

  /**
   * This isn't our data to expose, but it is useful to alias
   */
  get #visibleColumns() {
    let visiblility = meta.withFeature.forTable(this.table, 'columnVisibility');

    return visiblility.visibleColumns;
  }
}

/**
 * @private
 * Used for keeping track of and updating column order
 */
export class ColumnOrder {
  /**
   * This map will be empty until we re-order something.
   */
  map = new TrackedMap<string, number>();

  constructor(private args: { columns: () => Column[] }) {}

  @action
  set(key: string, position: number) {
    /**
     * Cannot set a position lower than the min value (before the beginning?)
     */
    if (position < 0) {
      return false;
    }

    /**
     * position is 0-indexed and length includes 0 in its count of items
     */
    let maxPosition = this.args.columns().length - 1;

    /**
     * Cannot set a position higher than the max value (after the end?)
     */
    if (position > maxPosition) {
      return false;
    }

    /**
     * Where did this column `key` come from? we can find out
     * by reading orderedMap
     */
    let currentPosition = this.orderedMap.get(key);

    assert(
      `Pre-existing position for ${key} could not be found. Does the column exist? ` +
        `The current positions are: ` +
        [...this.orderedMap.entries()].map((entry) => entry.join(' => ')).join(', ') +
        ` and the availableColumns are: ` +
        this.args.columns().map((column) => column.key) +
        ` and current "map" (${this.map.size}) is: ` +
        [...this.map.entries()].map((entry) => entry.join(' => ')).join(', '),
      undefined !== currentPosition
    );

    /**
     * No need to change anything if the position is the same
     * This helps reduce @tracked invalidations, which in turn reduces DOM thrashing.
     */
    if (currentPosition === position) {
      return false;
    }

    /**
     * For the columns between the gap we took `key` from and the `position`
     * we want to place that column, which direction do we move those middle columns?
     */
    let direction =
      currentPosition < position
        ? /**
           *   moved ------------------> to the right
           * currentPosition         position
           *   gap ^
           * columns left of position now need to shift left to fill that gap
           */
          'left'
        : /**
           *   moved <------------------ to the left
           * position         currentPosition
           *                    gap ^
           * columns right of position now need to shift right to fill that gap
           */
          'right';

    let keyByPosition = new Map<number, string>(
      [...this.orderedMap.entries()].map((entry) => entry.reverse() as [number, string])
    );

    for (let [existingPosition, key] of keyByPosition.entries()) {
      if (direction === 'left') {
        if (existingPosition > currentPosition && existingPosition <= position) {
          this.map.set(key, existingPosition - 1);
        }
      }

      if (direction === 'right') {
        if (existingPosition >= position && existingPosition <= currentPosition) {
          this.map.set(key, existingPosition + 1);
        }
      }
    }

    /**
     * Finally, set the position for the requested column
     */
    this.map.set(key, position);

    /**
     * Now that we've set the value for one column,
     * we need to make sure that all columns have a recorded position.
     */
    for (let [key, position] of this.orderedMap.entries()) {
      if (this.map.has(key)) continue;

      this.map.set(key, position);
    }
  }

  @action
  get(key: string) {
    let result = this.orderedMap.get(key);

    assert(
      `No position found for ${key}. Is the column used within this table?`,
      /* 0 is falsey, but it's a valid value for position */
      undefined !== result
    );

    return result;
  }

  /**
   * The same as this.map, but with all the columns' information
   */
  @cached
  get orderedMap(): ReadonlyMap<string, number> {
    return orderOf(this.args.columns(), this.map);
  }

  /**
   * When columns are removed or hidden, our positions don't change
   * but when doing the math, we want to adjust things based on 0-indexed counting
   *
   * TODO: figure out if we need this??
   */
  @cached
  get adjustedColumns(): Column[] {
    return [];
  }

  @cached
  get orderedColumns(): Column[] {
    let availableColumns = this.args.columns();
    let availableByKey = availableColumns.reduce((keyMap, column) => {
      keyMap[column.key] = column;

      return keyMap;
    }, {} as Record<string, Column>);
    let mergedOrder = orderOf(availableColumns, this.map);

    let result: Column[] = Array.from({ length: availableColumns.length });

    for (let [key, position] of mergedOrder.entries()) {
      let column = availableByKey[key];

      assert(`Could not find column for pair: ${key} @ @{position}`, column);
      result[position] = column;
    }

    assert(
      `Generated orderedColumns' length (${result.filter(Boolean).length}) ` +
        `does not match the length of available columns (${availableColumns.length}). ` +
        `orderedColumns: ${result
          .filter(Boolean)
          .map((c) => c.key)
          .join(', ')} -- ` +
        `available columns: ${availableColumns.map((c) => c.key).join(', ')}`,
      result.filter(Boolean).length === availableColumns.length
    );

    return result.filter(Boolean);
  }
}

/**
 * @private
 *
 * Utility for helping determine the percieved order of a set of columns
 * given the original (default) ordering, and then user-configurations
 */
export function orderOf(
  columns: { key: string }[],
  currentOrder: Map<string, number>
): Map<string, number> {
  let result = new Map<string, number>();
  let availableColumns = columns.map((column) => column.key);
  let availableSet = new Set(availableColumns);
  let current = new Map<number, string>(
    [...currentOrder.entries()].map(([key, position]) => [position, key])
  );

  /**
   * O(n * log(n)) ?
   */
  for (let i = 0; i < Math.max(columns.length, current.size); i++) {
    let orderedKey = current.get(i);

    if (orderedKey) {
      /**
       * If the currentOrder specifies columns not presently available,
       * ignore them
       */
      if (availableSet.has(orderedKey)) {
        result.set(orderedKey, i);
        continue;
      }
    }

    let availableKey: string | undefined;

    while ((availableKey = availableColumns.shift())) {
      if (result.has(availableKey) || currentOrder.has(availableKey)) {
        continue;
      }

      break;
    }

    if (!availableKey) {
      /**
       * The rest of our columns likely have their order set
       */
      continue;
    }

    result.set(availableKey, i);
  }

  // for (let remainingColumn of availableColumns) {
  //   result.set(remainingColumn, result.size);
  // }

  return result;
}
