import { action } from "mobx"
import { TypeFlags } from "./type-flags"

export interface ISnapshottable<S> {}

export interface IType<S, T> {
    name: string
    flags: TypeFlags
    is(thing: any): thing is S | T
    validate(thing: any, context: IContext): IValidationResult
    create(snapshot?: S, environment?: any): T
    isType: boolean
    describe(): string
    Type: T
    SnapshotType: S

    // Internal api's
    instantiate(parent: INode | null, subpath: string, environment: any, initialValue?: any): INode
    reconcile(current: INode, newValue: any): INode
    getValue(node: INode): T
    getSnapshot(node: INode): S
    applySnapshot(node: INode, snapshot: S): void
    applyPatchLocally(node: INode, subpath: string, patch: IJsonPatch): void
    getChildren(node: INode): INode[]
    getChildNode(node: INode, key: string): INode
    getChildType(key: string): IType<any, any>
    removeChild(node: INode, subpath: string): void
    isAssignableFrom(type: IType<any, any>): boolean
}

export interface ISimpleType<T> extends IType<T, T> {}

export interface IComplexType<S, T> extends IType<S, T & IStateTreeNode> {
    create(snapshot?: S, environment?: any): T & ISnapshottable<S>
}

/*
 * A complex type produces a MST node (Node in the state tree)
 */
export abstract class ComplexType<S, T> implements IType<S, T> {
    readonly isType = true
    readonly name: string

    constructor(name: string) {
        this.name = name
    }

    @action
    create(snapshot: S = this.getDefaultSnapshot(), environment?: any) {
        typecheck(this, snapshot)
        return this.instantiate(null, "", environment, snapshot).value
    }

    abstract instantiate(
        parent: INode | null,
        subpath: string,
        environment: any,
        initialValue: any
    ): INode

    abstract flags: TypeFlags
    abstract describe(): string

    abstract applySnapshot(node: INode, snapshot: any): void
    abstract getDefaultSnapshot(): any
    abstract getChildren(node: INode): INode[]
    abstract getChildNode(node: INode, key: string): INode
    abstract getValue(node: INode): T
    abstract getSnapshot(node: INode): any
    abstract applyPatchLocally(node: INode, subpath: string, patch: IJsonPatch): void
    abstract getChildType(key: string): IType<any, any>
    abstract removeChild(node: INode, subpath: string): void
    abstract isValidSnapshot(value: any, context: IContext): IValidationResult

    isAssignableFrom(type: IType<any, any>): boolean {
        return type === this
    }

    validate(value: any, context: IContext): IValidationResult {
        if (isStateTreeNode(value)) {
            return getType(value) === this || this.isAssignableFrom(getType(value))
                ? typeCheckSuccess()
                : typeCheckFailure(context, value)
            // it is tempting to compare snapshots, but in that case we should always clone on assignments...
        }
        return this.isValidSnapshot(value, context)
    }

    is(value: any): value is S | T {
        return this.validate(value, [{ path: "", type: this }]).length === 0
    }

    reconcile(current: INode, newValue: any): INode {
        if (current.snapshot === newValue)
            // newValue is the current snapshot of the node, noop
            return current
        if (isStateTreeNode(newValue) && getStateTreeNode(newValue) === current)
            // the current node is the same as the new one
            return current
        if (
            current.type === this &&
            isMutable(newValue) &&
            !isStateTreeNode(newValue) &&
            (!current.identifierAttribute ||
                current.identifier === newValue[current.identifierAttribute])
        ) {
            // the newValue has no node, so can be treated like a snapshot
            // we can reconcile
            current.applySnapshot(newValue)
            return current
        }
        // current node cannot be recycled in any way
        const { parent, subpath } = current
        current.die()
        // attempt to reuse the new one
        if (isStateTreeNode(newValue) && this.isAssignableFrom(getType(newValue))) {
            // newValue is a Node as well, move it here..
            const newNode = getStateTreeNode(newValue)
            newNode.setParent(parent, subpath)
            return newNode
        }
        // nothing to do, we have to create a new node
        return this.instantiate(parent, subpath, current._environment, newValue)
    }

    get Type(): T {
        return fail(
            "Factory.Type should not be actually called. It is just a Type signature that can be used at compile time with Typescript, by using `typeof type.Type`"
        )
    }
    get SnapshotType(): S {
        return fail(
            "Factory.SnapshotType should not be actually called. It is just a Type signature that can be used at compile time with Typescript, by using `typeof type.SnapshotType`"
        )
    }
}

export abstract class Type<S, T> extends ComplexType<S, T> implements IType<S, T> {
    constructor(name: string) {
        super(name)
    }

    abstract instantiate(
        parent: INode | null,
        subpath: string,
        environment: any,
        initialValue: any
    ): INode

    getValue(node: INode) {
        return node.storedValue
    }

    getSnapshot(node: INode) {
        return node.storedValue
    }

    getDefaultSnapshot() {
        return undefined
    }

    applySnapshot(node: INode, snapshot: S): void {
        fail("Immutable types do not support applying snapshots")
    }

    applyPatchLocally(node: INode, subpath: string, patch: IJsonPatch): void {
        fail("Immutable types do not support applying patches")
    }

    getChildren(node: INode): INode[] {
        return EMPTY_ARRAY as any
    }

    getChildNode(node: INode, key: string): INode {
        return fail(`No child '${key}' available in type: ${this.name}`)
    }

    getChildType(key: string): IType<any, any> {
        return fail(`No child '${key}' available in type: ${this.name}`)
    }

    reconcile(current: INode, newValue: any): INode {
        // reconcile only if type and value are still the same
        if (current.type === this && current.storedValue === newValue) return current
        const res = this.instantiate(
            current.parent,
            current.subpath,
            current._environment,
            newValue
        )
        current.die()
        return res
    }

    removeChild(node: INode, subpath: string): void {
        return fail(`No child '${subpath}' available in type: ${this.name}`)
    }
}

import { EMPTY_ARRAY, fail, isMutable } from "../utils"
import { isStateTreeNode, getStateTreeNode } from "../core/node/node-utils"
import {
    IContext,
    IValidationResult,
    typecheck,
    typeCheckFailure,
    typeCheckSuccess
} from "./type-checker"
import { INode, IStateTreeNode } from "../core/node/node-utils"
import { IJsonPatch } from "../core/json-patch"
import { getType } from "../core/mst-operations"
