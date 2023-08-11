import { deepMerge } from "https://deno.land/std@0.192.0/collections/deep_merge.ts";
import { z } from "https://deno.land/x/zod@v3.21.4/mod.ts";

// Define the options for the Dongoose function
interface DongooseOptions<T> {
  db: Deno.Kv;
  name: string;
  primaryIndexes?: Array<keyof T>;
  secondaryIndexes?: Array<keyof T>;
  timestamps?: boolean;
}

// Helper function to generate a collection name
const getKeysWithIndexes = (name: string, index: string) =>
  `${name}_by_${index}`;

// Helper function to update timestamps in the data
const updateTimestamps = (
  data: Record<string, unknown>,
  isInsertion: boolean,
) => {
  const now = Date.now();
  if (isInsertion) {
    data.createdAt = now;
  }
  data.updatedAt = now;
};

// Helper function to perform a transaction on the database
const performTransaction = (
  db: Deno.Kv,
  schemaName: string,
  primaryIndexes: Array<string>,
  data: Record<string, unknown>,
  operation: "set" | "delete",
) => {
  updateTimestamps(data, operation === "set");
  const transaction = db.atomic();
  for (const index of primaryIndexes) {
    const primaryIndex = getKeysWithIndexes(schemaName, index);
    transaction.check({
      key: [
        schemaName,
        primaryIndex,
        data[index] as string,
      ],
      versionstamp: null,
    });
  }

  for (const index of primaryIndexes) {
    const primaryIndex = getKeysWithIndexes(schemaName, index);
    transaction[operation]([
      schemaName,
      primaryIndex,
      (data[index] as string).toString(),
    ], data);
  }

  return transaction.commit();
};

// Main Dongoose function
export const Dongoose = <T extends z.ZodRawShape>(
  schema: T,
  { db, name, primaryIndexes, secondaryIndexes }: DongooseOptions<T>,
) => {
  const schemaName = name;
  const schemaPrimaryIndexes = [
    ...new Set([...primaryIndexes || [], "id"]),
  ] as const;

  const schemaSecondaryIndexes = [
    ...new Set([...secondaryIndexes || [], "id"]),
  ] as const;

  // Define the various schema validation objects
  const schemaValidationObject = z.object(schema);
  const schemaValidationObjectWithId = schemaValidationObject.extend({
    id: z.string().uuid(),
  });
  const schemaValidationFullObject = schemaValidationObjectWithId.extend({
    id: z.string().uuid(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  });
  const schemaValidationPartialObject = schemaValidationObject.partial();
  const schemaValidationPartialObjectWithId = schemaValidationObjectWithId
    .extend({
      id: z.string().uuid(),
    }).partial();

  // Define the various schema types
  type SchemaObject = z.infer<typeof schemaValidationObject>;
  type SchemaFullObject = z.infer<typeof schemaValidationFullObject>;
  type SchemaObjectWithId = z.infer<typeof schemaValidationObjectWithId>;
  type SchemaPartialObject = z.infer<typeof schemaValidationPartialObject>;
  type SchemaPartialObjectWithId = z.infer<
    typeof schemaValidationPartialObjectWithId
  >;

  // Define the various CRUD operations
  const create = (data: SchemaObject) => {
    schemaValidationObject.parse(data);
    const id = crypto.randomUUID();

    return performTransaction(
      db,
      schemaName,
      schemaPrimaryIndexes as Array<string>,
      {
        id,
        ...data,
      },
      "set",
    );
  };

  const findOne = async (query: SchemaPartialObjectWithId) => {
    schemaValidationPartialObjectWithId.parse(query);
    if (Object.keys(query).length === 0) {
      return null;
    }

    const results = await db.getMany<Array<SchemaFullObject>>(
      Object.entries(query).map<[string, string, string]>((
        [key, value],
      ) => [schemaName, getKeysWithIndexes(schemaName, key), value]),
    );
    return (results.find((result) => result.value)
      ?.value as SchemaFullObject) ?? null;
  };

  const find = async (query: SchemaPartialObjectWithId) => {
    schemaValidationPartialObjectWithId.parse(query);
    if (Object.keys(query).length === 0) {
      return null;
    }

    const resultMap = new Map<string, SchemaFullObject>();
    const filteredResult: SchemaFullObject[] = [];

    for await (const entry of db.list<any>({ prefix: [schemaName] })) {
      Object.entries(query).map(([key, value]) => {
        if (entry.value[key] === value) {
          if (!resultMap.has(entry.value.id)) {
            filteredResult.push(entry.value as SchemaFullObject);
            resultMap.set(entry.value.id, entry.value);
          }
        }
      });
    }

    return filteredResult ?? null;
  };

  // @ts-expect-error - generic type do not know that it has an id
  const findById = (id: string) => findOne({ id });

  const updateById = async (id: string, data: SchemaPartialObject) => {
    schemaValidationPartialObject.parse(data);
    // @ts-expect-error - generic type do not know that it has an id
    const item = await findOne({ id });
    if (!item) {
      return null;
    }
    const newData = deepMerge<SchemaFullObject>(item, data);
    return performTransaction(
      db,
      schemaName,
      schemaPrimaryIndexes as Array<string>,
      newData,
      "set",
    );
  };

  const updateOne = async (
    query: SchemaPartialObjectWithId,
    data: SchemaPartialObject,
  ) => {
    schemaValidationPartialObject.parse(data);
    const item = await findOne(query);
    if (!item) {
      return null;
    }
    // @ts-expect-error - generic type do not know that it has an id
    return updateById(item.id, data);
  };

  const deleteById = async (id: string) => {
    // @ts-expect-error - generic type do not know that it has an id
    const item = await findOne({ id });
    if (!item) {
      return null;
    }
    return performTransaction(
      db,
      name,
      schemaPrimaryIndexes as Array<string>,
      item,
      "delete",
    );
  };

  const deleteOne = async (query: SchemaPartialObjectWithId) => {
    const item = await findOne(query);
    if (!item) {
      return null;
    }
    return performTransaction(
      db,
      name,
      schemaPrimaryIndexes as Array<string>,
      item,
      "delete",
    );
  };

  const deleteAll = async () => {
    for await (const entry of db.list({ prefix: [schemaName] })) {
      await db.delete(entry.key);
    }
  };

  return {
    create,
    findOne,
    find,
    findById,
    updateOne,
    updateById,
    deleteOne,
    deleteById,
    deleteAll,
  };
};

// Define a set of common schema types for convenience
export const d = {
  string: z.string,
  number: z.number,
  boolean: z.boolean,
  bigint: z.bigint,
  date: z.date,
  array: z.array,
  object: z.object,
  tuple: z.tuple,
  enum: z.enum,
};
