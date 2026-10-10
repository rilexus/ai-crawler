// Runs an `extraction` callback against `defaults`. A builder chain fills in
// `defaults` itself. A returned `{ schema }` replaces it, falling back to
// `defaults` for anything it leaves out.
function buildSchema(defaults, extraction) {
  const { schema: predefinedSchema } =
    extraction(new SchemaBuilder(defaults)) ?? {};
  return predefinedSchema && predefinedSchema !== defaults
    ? { ...defaults, ...predefinedSchema }
    : defaults;
}

class SchemaBuilder {
  id = null;

  constructor(schema) {
    this.schema = schema;
  }

  entity(type) {
    this.schema.entityType = type;
    return this;
  }

  /**
   * @param {string} name
   * @param {string} description
   * @param {string} type
   * @param {(builder: SchemaBuilder) => SchemaBuilder | { schema: object } | void} [extraction]
   *   Builds the nested schema of an `object` or `array` field with
   *   `builder`, or returns `{ schema }` with a predefined schema, such as one
   *   from `client.schema.createSchema()`.
   * @returns {this}
   */
  field(name, description, type, extraction) {
    const field = {
      name,
      ...(typeof extraction === "function" ? { entityType: null } : {}),
      description,
      dataType: type,
    };

    if (typeof extraction === "function") {
      const nested = buildSchema(
        { entityType: null, classifications: [], fields: [] },
        extraction,
      );
      field.entityType = nested.entityType;
      field.classifications = nested.classifications;
      field.fields = nested.fields;
    }

    this.schema.fields.push(field);
    return this;
  }

  classify(type, description, options) {
    this.schema.classifications.push({
      type,
      description,
      options,
    });
    return this;
  }
}

module.exports = { SchemaBuilder, buildSchema };
