/** Font-independent geometry in a 24 × 24 coordinate space. */
export type IconPart = {kind:'line';x1:number;y1:number;x2:number;y2:number}|{kind:'box';x:number;y:number;w:number;h:number;r?:number;fill?:boolean};
const line=(x1:number,y1:number,x2:number,y2:number):IconPart=>({kind:'line',x1,y1,x2,y2});
const box=(x:number,y:number,w:number,h:number,r=0,fill=false):IconPart=>({kind:'box',x,y,w,h,r,fill});
const circle=(x:number,y:number,r:number,fill=false)=>box(x-r,y-r,r*2,r*2,r,fill);
const path=(...points:number[]):IconPart[]=>Array.from({length:points.length/2-1},(_,i)=>line(points[i*2],points[i*2+1],points[i*2+2],points[i*2+3]));
const down=path(6,9,12,15,18,9),right=path(9,6,15,12,9,18),up=path(6,15,12,9,18,15);
const swap=[...path(3,7,21,7,17,3),...path(21,17,3,17,7,21)];
const info=[circle(12,12,9),circle(12,7,1,true),line(12,11,12,17)];
export const iconShapes:Record<string,IconPart[]>={
 ChevronDown:down,ChevronUp:up,ChevronRight:right,ChevronLeft:path(15,6,9,12,15,18),ChevronsUpDown:[...path(8,8,12,4,16,8),...path(8,16,12,20,16,16)],
 ArrowLeft:[...path(11,5,4,12,11,19),line(4,12,21,12)], ArrowLeftRight:swap,GitCompare:swap,
 Ellipsis:[circle(5,12,1.6,true),circle(12,12,1.6,true),circle(19,12,1.6,true)],
 X:[line(6,6,18,18),line(6,18,18,6)],CircleX:[circle(12,12,9),line(8,8,16,16),line(8,16,16,8)],
 Search:[circle(10,10,6),line(15,15,21,21)],Info:info,CircleAlert:[circle(12,12,9),line(12,6,12,12),circle(12,17,1,true)],
 FolderTree:[box(3,3,7,5,1),box(14,10,7,5,1),box(14,18,7,4,1),...path(6,8,6,20,14,20),line(6,12,14,12)],
 List:[circle(4,6,1,true),circle(4,12,1,true),circle(4,18,1,true),line(9,6,21,6),line(9,12,21,12),line(9,18,21,18)],
 GitBranch:[circle(6,5,2),circle(6,19,2),circle(18,5,2),line(6,7,6,17),...path(18,7,18,10,15,13,6,13)],
 Clock:[circle(12,12,9),...path(12,6,12,12,16,14)],
 Copy:[box(8,8,13,13,2),...path(5,16,3,16,3,3,16,3,16,5)],
 ExternalLink:[...path(13,3,21,3,21,11),line(21,3,10,14),...path(9,5,3,5,3,21,19,21,19,15)],
 Lock:[box(5,10,14,11,2),...path(8,10,8,6,10,3,14,3,16,6,16,10),line(12,14,12,17)],
 RefreshCw:[...path(20,8,17,4,10,3,5,6,3,12,5,18,11,21,17,19,20,15),...path(20,3,20,8,15,8)],
 Columns2:[box(3,3,18,18,2),line(12,3,12,21)],Rows3:[box(3,3,18,18,2),line(3,9,21,9),line(3,15,21,15)],
 Folder:[...path(3,20,3,5,10,5,12,8,21,8,21,20,3,20)],
 MessageSquare:path(4,3,20,3,20,17,10,17,4,21,4,3),
 Check:path(4,12,10,18,21,5),Pin:[...path(8,3,16,3,15,10,19,14,5,14,9,10,8,3),line(12,14,12,22)],
};
export const genericIcon:IconPart[]=[box(4,4,16,16,3),line(8,12,16,12),line(12,8,12,16)];
export function iconGeometry(name:string){return iconShapes[name]||genericIcon;}
