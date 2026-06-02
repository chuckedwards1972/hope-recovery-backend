const{Pool}=require('pg'),bcrypt=require('bcryptjs');
const pool=new Pool({connectionString:'postgresql://postgres:jbDvuGAGMQuzwqvZdtAwRcTokPMtpOuT@shuttle.proxy.rlwy.net:21783/railway',ssl:{rejectUnauthorized:false}});
async function run(){
  const c=await pool.connect();
  const cols=(await c.query("SELECT column_name FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position")).rows.map(r=>r.column_name);
  console.log('cols:',cols.join(','));
  const h=await bcrypt.hash('ACTS2:38',12);
  const f=['id','email','name','password','role','username','title'];
  const v=['gen_random_uuid()','$1','$2','$3','$4','$5','$6'];
  const p=['bro.chuck.edwards@gmail.com','Chuck Edwards',h,'platform_owner','RRNHQ','Platform Owner'];
  if(cols.includes('level')){f.push('level');v.push('0');}
  if(cols.includes('isActive')){f.push('"isActive"');v.push('true');}
  if(cols.includes('createdAt')){f.push('"createdAt"');v.push('NOW()');}
  if(cols.includes('updatedAt')){f.push('"updatedAt"');v.push('NOW()');}
  const sql=`INSERT INTO users (${f.join(',')}) VALUES (${v.join(',')}) ON CONFLICT (email) DO UPDATE SET password=$3,username=$5,role=$4,name=$2,"updatedAt"=NOW() RETURNING id,username,role`;
  const r=await c.query(sql,p);
  console.log('OK',JSON.stringify(r.rows[0]));
  const v2=await c.query('SELECT password FROM users WHERE username=$1',['RRNHQ']);
  console.log('pw check:',await bcrypt.compare('ACTS2:38',v2.rows[0].password)?'PASS':'FAIL');
  c.release();await pool.end();
}
run().catch(e=>{console.error('FATAL:',e.message);process.exit(1);});
