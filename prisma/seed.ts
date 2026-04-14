import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
const prisma = new PrismaClient();
async function main() {
  const hash = (p: string) => bcrypt.hashSync(p, 10);
  const portAllen = await prisma.campus.upsert({ where:{slug:'hope-port-allen'}, update:{}, create:{name:'HOPE Place Port Allen',slug:'hope-port-allen',address:'12883 Hwy 190 West',city:'Port Allen',state:'LA',phone:'225-333-0330',email:'bro.chuck.edwards@gmail.com',lifecycleStage:'ACTIVE'} });
  console.log('Campus: Port Allen', portAllen.id);
  const pineville = await prisma.campus.upsert({ where:{slug:'hope-pineville'}, update:{}, create:{name:'HOPE Place Pineville',slug:'hope-pineville',address:'104 Blair Road',city:'Pineville',state:'LA',lifecycleStage:'ACTIVE'} });
  console.log('Campus: Pineville', pineville.id);
  const laplace = await prisma.campus.upsert({ where:{slug:'hope-laplace'}, update:{}, create:{name:'HOPE Place LaPlace',slug:'hope-laplace',city:'LaPlace',state:'LA',lifecycleStage:'ACTIVE'} });
  console.log('Campus: LaPlace', laplace.id);
  const chuck = await prisma.user.upsert({ where:{email:'bro.chuck.edwards@gmail.com'}, update:{}, create:{email:'bro.chuck.edwards@gmail.com',passwordHash:hash('ACTS2:38'),name:'Chuck Edwards',role:'HQ_ADMIN',level:0,campusId:portAllen.id} });
  console.log('User: Chuck', chuck.id);
  const elizabeth = await prisma.user.upsert({ where:{email:'elizabeth.olinde@hopenetwork.com'}, update:{}, create:{email:'elizabeth.olinde@hopenetwork.com',passwordHash:hash('HOPE2024!'),name:'Elizabeth Olinde',role:'AMBASSADOR',level:3,campusId:portAllen.id} });
  console.log('User: Elizabeth', elizabeth.id);
  const tina = await prisma.user.upsert({ where:{email:'tina.bushnell@hopenetwork.com'}, update:{}, create:{email:'tina.bushnell@hopenetwork.com',passwordHash:hash('HOPE2024!'),name:'Tina Bradly Bushnell',role:'CAMPUS_LEADER',level:3,campusId:pineville.id} });
  console.log('User: Tina', tina.id);
  const tiffany = await prisma.user.upsert({ where:{email:'tiffany.howard@hopenetwork.com'}, update:{}, create:{email:'tiffany.howard@hopenetwork.com',passwordHash:hash('HOPE2024!'),name:'Tiffany Howard',role:'CAMPUS_LEADER',level:3,campusId:laplace.id} });
  console.log('User: Tiffany', tiffany.id);
  const lashawnda = await prisma.user.upsert({ where:{email:'lashawnda.gibson@hopenetwork.com'}, update:{}, create:{email:'lashawnda.gibson@hopenetwork.com',passwordHash:hash('HOPE2024!'),name:'Lashawnda Gibson',role:'MEMBER',level:5,campusId:portAllen.id} });
  console.log('User: Lashawnda', lashawnda.id);
  console.log('Seed complete!');
}
main().catch(console.error).finally(() => prisma.$disconnect());
