"use strict";

const Promise = require('bluebird');
const uuid = require('uuid');

const NucleusError = require('./Error.nucleus');
const NucleusResource = require('./Resource.nucleus');

const nucleusValidator = require('./validator.nucleus');

const RESOURCE_ID_BY_TYPE_TABLE_NAME = 'ResourceIDByType';

class NucleusResourceAPI {

  /**
   * Creates a resource given its name and an object of its attributes.
   *
   * @Nucleus ActionName CreateResource
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel resourceAttributes originUserID
   * @Nucleus ExtendableActionName `Create${resourceType}`
   * @Nucleus ExtendableEventName `${resourceType}Created`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' 'NucleusResourceModel' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}Attributes` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}` NucleusResourceModel Nucleus.generateResourceModelFromResourceStructureByResourceType(`${resourceType}`)
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {Object} resourceAttributes
   * @argument {String} originUserID
   * @argument {String} [parentNodeID]
   *
   * @returns {Promise<{ resource: NucleusResource, resourceAuthorID: String, resourceMemberNodeID: String }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource model is not an instance of NucleusResource.
   * @throws Will throw an error if the resource attributes is not an object.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if no datastore is passed.
   * @throws Will throw an error if the resource is not conform to the model.
   */
  static async createResource (resourceType, NucleusResourceModel, resourceAttributes, originUserID, parentNodeID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isFunction(NucleusResourceModel)) throw new NucleusError.UnexpectedValueTypeNucleusError("The Nucleus resource model must be an instance of NucleusResource.");
    if (!nucleusValidator.isObject(resourceAttributes)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource attributes must be an object.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    const { $datastore, $resourceRelationshipDatastore } = this;

    if (nucleusValidator.isEmpty($datastore)) throw new NucleusError.UndefinedContextNucleusError("No datastore is provided.");

    if (!!$resourceRelationshipDatastore && !parentNodeID) [ parentNodeID ] = await $resourceRelationshipDatastore.retrieveObjectOfRelationshipWithSubject(originUserID, 'is-member');

    if (!parentNodeID) throw new NucleusError(`Could not retrieve the node which the origin user (${originUserID}) is member of.`);

    try {
      const reservedResourceID = resourceAttributes.ID;
      Reflect.deleteProperty(resourceAttributes, 'ID');
      Reflect.deleteProperty(resourceAttributes, 'meta');
      const $resource = new NucleusResourceModel(resourceAttributes, originUserID, reservedResourceID);
      const resourceItemKey = $resource.generateOwnItemKey();

      return Promise.all([
        $datastore.addItemToHashFieldByName(resourceItemKey, $resource),
        $datastore.addItemToSetByName(RESOURCE_ID_BY_TYPE_TABLE_NAME, resourceType, $resource.ID),
      ])
        .then(() => {
          if (!$resourceRelationshipDatastore) return;

          return Promise.all([
            $resourceRelationshipDatastore.createRelationshipBetweenSubjectAndObject($resource.ID, 'is-member', parentNodeID),
            $resourceRelationshipDatastore.createRelationshipBetweenSubjectAndObject($resource.ID, 'is-authored', originUserID)
          ]);
        })
        .return({ resource: $resource, resourceAuthorID: originUserID, resourceMemberNodeID: parentNodeID });
    } catch (error) {

      throw new NucleusError(`Could not create ${resourceType} because of an external error: ${error}`, { error });
    }
  }

  /**
   * Removes a resource given its name and ID.
   *
   * @Nucleus ActionName RemoveResourceByID
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel resourceID originUserID
   * @Nucleus ExtendableActionName `Remove${resourceType}ByID`
   * @Nucleus ExtendableEventName `${resourceType}ByIDRemoved`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}ID` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}`
   *
   * @argument {String} resourceType
   * @argument {String} resourceID
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resourceID: String }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource ID is not a string.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if no datastore is passed.
   * @throws Will throw an error if the origin user is not authorized to remove the resource.
   * @throws Will throw an error if the resource does not exist.
   */
  static async removeResourceByID (resourceType, resourceID, originUserID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isString(resourceID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource ID must be a string.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    const { $datastore, $resourceRelationshipDatastore } = this;

    if (nucleusValidator.isEmpty($datastore)) throw new NucleusError.UndefinedContextNucleusError("No datastore is provided.");

    const { canUpdateResource } = await NucleusResourceAPI.verifyThatUserCanUpdateResource.call(this, originUserID, resourceID);

    if (!canUpdateResource) throw new NucleusError.UnauthorizedActionNucleusError(`The user ("${originUserID}") is not authorized to remove the ${resourceType} ("${resourceID}")`);

    const resourceItemKey = NucleusResource.generateItemKey(resourceType, resourceID);

    const resourceExists = !!(await $datastore.$$server.existsAsync(resourceItemKey));

    if (!resourceExists) throw new NucleusError.UndefinedContextNucleusError(`The ${resourceType} ("${resourceID}") does not exist.`);

    return Promise.all([
      $datastore.removeItemByName(resourceItemKey),
    ])
      .then(() => {
        if (!$resourceRelationshipDatastore) return;

        return $resourceRelationshipDatastore.removeAllRelationshipsToVector(resourceID);
      })
      .return({ resourceID });
  }

  /**
   * Retrieves a resource given its ID.
   *
   * @Nucleus ActionName RetrieveResourceByID
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel resourceID originUserID
   * @Nucleus ExtendableActionName `Retrieve${resourceType}ByID`
   * @Nucleus ExtendableEventName `${resourceType}ByIDRetrieved`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' 'NucleusResourceModel' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}ID` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}` NucleusResourceModel Nucleus.generateResourceModelFromResourceStructureByResourceType(`${resourceType}`)
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {String} resourceID
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resource: NucleusResource }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource model is not an instance of NucleusResource.
   * @throws Will throw an error if the resource ID is not a string.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if no datastore is passed.
   * @throws Will throw an error if the origin user is not authorized to retrieve the resource.
   * @throws Will throw an error if the resource does not exist.
   */
  static async retrieveResourceByID (resourceType, NucleusResourceModel, resourceID, originUserID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isFunction(NucleusResourceModel)) throw new NucleusError.UnexpectedValueTypeNucleusError("The Nucleus resource model must be an instance of NucleusResource.");
    if (!nucleusValidator.isString(resourceID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource ID must be a string.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    const { $datastore } = this;

    if (nucleusValidator.isEmpty($datastore)) throw new NucleusError.UndefinedContextNucleusError("No datastore is provided.");

    const { canRetrieveResource } = await NucleusResourceAPI.verifyThatUserCanRetrieveResource.call(this, originUserID, resourceID);

    if (!canRetrieveResource) throw new NucleusError.UnauthorizedActionNucleusError(`The user ("${originUserID}") is not authorized to retrieve the ${resourceType} ("${resourceID}")`);

    const resourceItemKey = NucleusResource.generateItemKey(resourceType, resourceID);

    const resourceExists = !!(await $datastore.$$server.existsAsync(resourceItemKey));

    if (!resourceExists) throw new NucleusError.UndefinedContextNucleusError(`The ${resourceType} ("${resourceID}") does not exist.`);

    return $datastore.retrieveAllItemsFromHashByName(resourceItemKey)
      .then((resourceAttributes) => {
        const $resource = new NucleusResourceModel(resourceAttributes, originUserID);

        return { resource: $resource };
      });
  }

  /**
   * Updates a resource given its ID.
   *
   * @Nucleus ActionName UpdateResourceByID
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel resourceID resourceAttributes originUserID
   * @Nucleus ExtendableActionName `Update${resourceType}ByID`
   * @Nucleus ExtendableEventName `${resourceType}ByIDUpdated`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' 'NucleusResourceModel' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}ID` `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}Attributes` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}` NucleusResourceModel Nucleus.generateResourceModelFromResourceStructureByResourceType(`${resourceType}`)
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {String} resourceID
   * @argument {Object} resourceAttributes
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resource: NucleusResource }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource model is not an instance of NucleusResource.
   * @throws Will throw an error if the resource ID is not a string.
   * @throws Will throw an error if the resource attributes is not an object.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if no datastore is passed.
   * @throws Will throw an error if the origin user is not authorized to retrieve the resource.
   * @throws Will throw an error if the resource does not exist.
   */
  static async updatesResourceByID (resourceType, NucleusResourceModel, resourceID, resourceAttributes, originUserID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isFunction(NucleusResourceModel)) throw new NucleusError.UnexpectedValueTypeNucleusError("The Nucleus resource model must be an instance of NucleusResource.");
    if (!nucleusValidator.isString(resourceID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource ID must be a string.");
    if (!nucleusValidator.isObject(resourceAttributes)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource attributes must be an object.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    const { $datastore } = this;

    if (nucleusValidator.isEmpty($datastore)) throw new NucleusError.UndefinedContextNucleusError("No datastore is provided.");

    const { canUpdateResource } = await NucleusResourceAPI.verifyThatUserCanUpdateResource.call(this, originUserID, resourceID);

    if (!canUpdateResource) throw new NucleusError.UnauthorizedActionNucleusError(`The user ("${originUserID}") is not authorized to update the ${resourceType} ("${resourceID}")`);

    const resourceItemKey = NucleusResource.generateItemKey(resourceType, resourceID);

    const resourceExists = !!(await $datastore.$$server.existsAsync(resourceItemKey));

    if (!resourceExists) throw new NucleusError.UndefinedContextNucleusError(`The ${resourceType} ("${resourceID}") does not exist.`);

    return $datastore.retrieveAllItemsFromHashByName(resourceItemKey)
      .then((staleResourceAttributes) => {
        const updatedISOTime = new Date().toISOString();
        staleResourceAttributes.meta = Object.assign({ updatedISOTime }, staleResourceAttributes.meta);

        Reflect.deleteProperty(resourceAttributes, 'ID');
        Reflect.deleteProperty(resourceAttributes, 'meta');

        const $resource = new NucleusResourceModel(Object.assign({}, staleResourceAttributes, resourceAttributes), originUserID);

        $resource.meta.updatedISOTime = new Date().toISOString();

        return $datastore.addItemToHashFieldByName(resourceItemKey, Object.assign({}, { meta: $resource.meta }, resourceAttributes))
          .return({ resource: $resource });
      });
  }

  /**
   * Verifies that the user can retrieve a given resource based on the hierarchy.
   *
   * @argument userID
   * @argument resourceID
   *
   * @returns {Promise<{ canRetrieveResource: Boolean }>}
   */
  static async verifyThatUserCanRetrieveResource (userID, resourceID) {
    const { $resourceRelationshipDatastore } = this;

    if (!$resourceRelationshipDatastore) return { canRetrieveResource: true };

    const userAncestorNodeIDList = await NucleusResourceAPI.walkHierarchyTreeUpward.call(this, userID);
    const userDirectAncestorChildrenNodeIDList = await NucleusResourceAPI.walkHierarchyTreeDownward.call(this, userAncestorNodeIDList[0]);
    const resourceAncestorNodeIDList = await NucleusResourceAPI.walkHierarchyTreeUpward.call(this, resourceID);

    const nodeIDIntersectionList = userAncestorNodeIDList.slice(0).concat(userDirectAncestorChildrenNodeIDList)
      .filter((nodeID) => {

        return resourceAncestorNodeIDList.indexOf(nodeID) !== -1;
      });

    if (nodeIDIntersectionList.length === 0) return { canRetrieveResource: false };

    return { canRetrieveResource: true };
  }

  /**
   * Verifies that the user can update a given resource based on the hierarchy.
   *
   * @argument userID
   * @argument resourceID
   *
   * @returns {Promise<{ canUpdateResource: Boolean }>}
   */
  static async verifyThatUserCanUpdateResource (userID, resourceID) {
    const { $resourceRelationshipDatastore } = this;

    if (!$resourceRelationshipDatastore) return { canUpdateResource: true };

    const userDirectAncestorNodeIDList = await $resourceRelationshipDatastore.retrieveObjectOfRelationshipWithSubject(userID, 'is-member');
    const userDirectAncestorChildrenNodeIDList = await NucleusResourceAPI.walkHierarchyTreeDownward.call(this, userDirectAncestorNodeIDList[0]);
    const resourceAncestorNodeIDList = await NucleusResourceAPI.walkHierarchyTreeUpward.call(this, resourceID);

    const nodeIDIntersectionList = userDirectAncestorNodeIDList.slice(0).concat(userDirectAncestorChildrenNodeIDList)
      .filter((nodeID) => {

        return resourceAncestorNodeIDList.indexOf(nodeID) !== -1;
      });

    if (nodeIDIntersectionList.length === 0) return { canUpdateResource: false };

    return { canUpdateResource: true };
  }

  /**
   * Recursively walks down all the branches of a given resource and collect every children.
   *
   * @argument {String} resourceID
   * @argument {Number} [depth=Infinity]
   *
   * @returns {Promise<Array>}
   */
  static async walkHierarchyTreeDownward (resourceID, depth = Infinity) {
    const { $resourceRelationshipDatastore } = this;

    if (!$resourceRelationshipDatastore) return [];

    const nodeIDList = [];

    async function retrieveAncestorForResourceByID (resourceID) {
      const childrenNodeIDList = await $resourceRelationshipDatastore.retrieveSubjectOfRelationshipWithObject(resourceID, 'is-member');

      if (childrenNodeIDList.length === 0 || !!~childrenNodeIDList.indexOf('SYSTEM')) return null;

      childrenNodeIDList
        .forEach((nodeID) => {
          if (!~nodeIDList.indexOf(nodeID)) nodeIDList.push(nodeID);
        }, nodeIDList);

      if (nodeIDList.length >= depth) return;

      return Promise.all(childrenNodeIDList
        .map(retrieveAncestorForResourceByID.bind(this)));
    }

    return new Promise(async (resolve, reject) => {
      await retrieveAncestorForResourceByID.call(this, resourceID);

      resolve(nodeIDList);
    });
  }

  /**
   * Recursively walks up all the branches of a given resource and collect every ancestors.
   *
   * @argument {String} nodeID
   * @argument {Number} [depth=Infinity]
   *
   * @returns {Promise<Array>}
   */
  static async walkHierarchyTreeUpward (resourceID, depth = Infinity) {
    const { $resourceRelationshipDatastore } = this;

    const nodeIDList = [];

    async function retrieveAncestorForResourceByID (resourceID) {
      const ancestorNodeIDList = await $resourceRelationshipDatastore.retrieveObjectOfRelationshipWithSubject(resourceID, 'is-member');

      if (ancestorNodeIDList.length === 0 || !!~ancestorNodeIDList.indexOf('SYSTEM')) return null;

      ancestorNodeIDList
        .forEach((nodeID) => {
          if (!~nodeIDList.indexOf(nodeID)) nodeIDList.push(nodeID);
        }, nodeIDList);

      if (nodeIDList.length >= depth) return;

      return Promise.all(ancestorNodeIDList
        .map(retrieveAncestorForResourceByID.bind(this)));
    }

    return new Promise(async (resolve, reject) => {
      await retrieveAncestorForResourceByID.call(this, resourceID);

      resolve(nodeIDList);
    });
  }
}

module.exports = NucleusResourceAPI;