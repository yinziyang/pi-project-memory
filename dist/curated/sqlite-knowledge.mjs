const TEXT_FIELDS=['project','type','title','subtitle','narrative','facts','concepts','created_at'];
const INTEGER_FIELDS=['id','created_at_epoch'];
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});

/** 校验项目参数后才能用于绑定或作用域比较，禁止编码器静默替换未配对代理项。 */
export function validateKnowledgeProject(project) {
  if(typeof project!=='string'||!project.isWellFormed()||!project.trim())throw new Error('KNOWLEDGE_INVALID_PROJECT');
}

/**
 * 从调用方持有的同一SQLite连接／事务快照读取知识字段，先查询typeof和BLOB，不让Bun先解码TEXT。
 * selectedIds缺省时检查整个发布库的单项目不变量，指定时只读取已校验的精选安全整数ID。
 * 数据库编码必须是UTF-8，TEXT允许原始BOM、非BMP及空白，保留SQL NULL与JSON词法原文，facts/concepts仅支持JSON字符串数组或SQL NULL，拒绝TEXT null及legacy plainString。
 * 调用方拥有连接和事务，本函数不提交、不写库、不创建资源，错误只含固定字段名和错误类别，不包含正文。
 */
export function readKnowledgeRows(db,{project,selectedIds}={}) {
  if(db.query('PRAGMA encoding').get().encoding!=='UTF-8')throw new Error('KNOWLEDGE_DB_ENCODING');
  if(project!==undefined)validateKnowledgeProject(project);
  if(selectedIds!==undefined&&(!Array.isArray(selectedIds)||!selectedIds.length||selectedIds.some(id=>!Number.isSafeInteger(id)||id<=0)||new Set(selectedIds).size!==selectedIds.length))throw new Error('KNOWLEDGE_INVALID_IDS');
  const fields=[...TEXT_FIELDS,...INTEGER_FIELDS];
  const projection=fields.map(field=>`typeof(${field}) AS ${field}_type,CAST(${field} AS BLOB) AS ${field}_bytes`).join(',');
  const select=db.query(`SELECT ${projection} FROM observations ${selectedIds?'WHERE id=?':'ORDER BY id'}`);
  const raw=selectedIds?selectedIds.map(id=>{const rows=select.all(id);if(rows.length!==1)throw new Error('KNOWLEDGE_ID_CARDINALITY');return rows[0];}):select.all();
  let scopedProject=project;
  const seenIds=new Set();
  return raw.map(record=>{
    const row={};
    for(const field of fields){
      const type=record[field+'_type'],bytes=record[field+'_bytes'];
      if(type==='null'&&['title','subtitle','narrative','facts','concepts'].includes(field)){row[field]=null;continue;}
      if(type!==(INTEGER_FIELDS.includes(field)?'integer':'text'))throw new Error(`KNOWLEDGE_TYPE_${field}`);
      let text;try{text=decoder.decode(bytes);}catch{throw new Error(`KNOWLEDGE_UTF8_${field}`);}
      if(!text.isWellFormed())throw new Error(`KNOWLEDGE_UNICODE_${field}`);
      if(INTEGER_FIELDS.includes(field)){
        if(!/^-?\d+$/.test(text)||!Number.isSafeInteger(Number(text))||(field==='id'&&Number(text)<=0))throw new Error(`KNOWLEDGE_INTEGER_${field}`);
        row[field]=Number(text);
      }else row[field]=text;
    }
    if(seenIds.has(row.id))throw new Error('KNOWLEDGE_DUPLICATE_ID');
    seenIds.add(row.id);
    validateKnowledgeProject(row.project);
    if(scopedProject===undefined)scopedProject=row.project;
    if(row.project!==scopedProject)throw new Error('KNOWLEDGE_PROJECT_MISMATCH');
    const lists={};
    for(const field of ['facts','concepts']){
      let value;try{value=row[field]===null?null:JSON.parse(row[field]);}catch{throw new Error(`KNOWLEDGE_JSON_${field}`);}
      if(row[field]!==null&&(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!item.isWellFormed())))throw new Error(`KNOWLEDGE_LIST_${field}`);
      lists[field]=value||[];
    }
    if(![row.title,row.subtitle,row.narrative,...lists.facts].some(value=>typeof value==='string'&&value.trim()))throw new Error('KNOWLEDGE_EMPTY_BODY: 不支持仅text或空知识正文');
    return row;
  });
}
