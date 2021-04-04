// FancyZoom.js - v1.1 - http://www.fancyzoom.com
//
// Copyright (c) 2008 Cabel Sasser / Panic Inc
// All rights reserved.
// 
//     Requires: FancyZoomHTML.js
// Instructions: Include JS files in page, call setupZoom() in onLoad. That's it!
//               Any <a href> links to images will be updated to zoom inline.
//               Add rel="nozoom" to your <a href> to disable zooming for an image.
// 
// Redistribution and use of this effect in source form, with or without modification,
// are permitted provided that the following conditions are met:
// 
// * USE OF SOURCE ON COMMERCIAL (FOR-PROFIT) WEBSITE REQUIRES ONE-TIME LICENSE FEE PER DOMAIN.
//   Reasonably priced! Visit www.fancyzoom.com for licensing instructions. Thanks!
//
// * Non-commercial (personal) website use is permitted without license/payment!
//
// * Redistribution of source code must retain the above copyright notice,
//   this list of conditions and the following disclaimer.
//
// * Redistribution of source code and derived works cannot be sold without specific
//   written prior permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR
// CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
// EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
// PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
// PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
// LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
// NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

var includeCaption = true; // Turn on the "caption" feature, and write out the caption HTML
var zoomTime       = 5;    // Milliseconds between frames of zoom animation
var zoomSteps      = 15;   // Number of zoom animation frames
var includeFade    = 1;    // Set to 1 to fade the image in / out as it zooms
var minBorder      = 90;   // Amount of padding between large, scaled down images, and the window edges
var shadowSettings = '0px 5px 25px rgba(0, 0, 0, '; // Blur, radius, color of shadow for compatible browsers

var zoomImagesURI   = 'img/zoom/'; // Location of the zoom and shadow images

function setupZoom(){prepZooms();insertZoomHTML();zoomdiv=document.getElementById(zoomID);zoomimg=document.getElementById(theID)}function prepZooms(){if(!document.getElementsByTagName){return}var e=document.getElementsByTagName("a");for(i=0;i<e.length;i++){if(e[i].getAttribute("href")){if(e[i].getAttribute("href").search(/(.*)\.(jpg|jpeg|gif|png|bmp|tif|tiff)/gi)!=-1){if(e[i].getAttribute("rel")!="nozoom"){e[i].onclick=function(e){return zoomClick(this,e)};e[i].onmouseover=function(){zoomPreload(this)}}}}}}function zoomPreload(e){var t=e.getAttribute("href");if(imgPreload.src.indexOf(e.getAttribute("href").substr(e.getAttribute("href").lastIndexOf("/")))==-1){preloadActive=true;imgPreload=new Image;imgPreload.onload=function(){preloadActive=false};imgPreload.src=t}}function preloadAnimStart(){preloadTime=new Date;document.getElementById("ZoomSpin").style.left=myWidth/2+"px";document.getElementById("ZoomSpin").style.top=myHeight/2+myScroll+"px";document.getElementById("ZoomSpin").style.visibility="visible";preloadFrame=1;document.getElementById("SpinImage").src=zoomImagesURI+"zoom-spin-"+preloadFrame+".png";preloadAnimTimer=setInterval("preloadAnim()",100)}function preloadAnim(e){if(preloadActive!=false){document.getElementById("SpinImage").src=zoomImagesURI+"zoom-spin-"+preloadFrame+".png";preloadFrame++;if(preloadFrame>12)preloadFrame=1}else{document.getElementById("ZoomSpin").style.visibility="hidden";clearInterval(preloadAnimTimer);preloadAnimTimer=0;zoomIn(preloadFrom)}}function zoomClick(e,t){var n=getShift(t);if(!t&&window.event&&(window.event.metaKey||window.event.altKey)){return true}else if(t&&(t.metaKey||t.altKey)){return true}getSize();if(preloadActive==true){if(preloadAnimTimer==0){preloadFrom=e;preloadAnimStart()}}else{zoomIn(e,n)}return false}function zoomIn(e,t){zoomimg.src=e.getAttribute("href");if(e.childNodes[0].width){startW=e.childNodes[0].width;startH=e.childNodes[0].height;startPos=findElementPos(e.childNodes[0])}else{startW=50;startH=12;startPos=findElementPos(e)}hostX=startPos[0];hostY=startPos[1];if(document.getElementById("scroller")){hostX=hostX-document.getElementById("scroller").scrollLeft}endW=imgPreload.width;endH=imgPreload.height;if(zoomActive[theID]!=true){if(document.getElementById("ShadowBox")){document.getElementById("ShadowBox").style.visibility="hidden"}else if(!browserIsIE){if(fadeActive["ZoomImage"]){clearInterval(fadeTimer["ZoomImage"]);fadeActive["ZoomImage"]=false;fadeTimer["ZoomImage"]=false}document.getElementById("ZoomImage").style.webkitBoxShadow=shadowSettings+"0.0)"}document.getElementById("ZoomClose").style.visibility="hidden";if(includeCaption){document.getElementById(zoomCaptionDiv).style.visibility="hidden";if(e.getAttribute("title")&&includeCaption){document.getElementById(zoomCaption).innerHTML=e.getAttribute("title")}else{document.getElementById(zoomCaption).innerHTML=""}}zoomOrigW[theID]=startW;zoomOrigH[theID]=startH;zoomOrigX[theID]=hostX;zoomOrigY[theID]=hostY;zoomimg.style.width=startW+"px";zoomimg.style.height=startH+"px";zoomdiv.style.left=hostX+"px";zoomdiv.style.top=hostY+"px";if(includeFade==1){setOpacity(0,zoomID)}zoomdiv.style.visibility="visible";sizeRatio=endW/endH;if(endW>myWidth-minBorder){endW=myWidth-minBorder;endH=endW/sizeRatio}if(endH>myHeight-minBorder){endH=myHeight-minBorder;endW=endH*sizeRatio}zoomChangeX=myWidth/2-endW/2-hostX;zoomChangeY=myHeight/2-endH/2-hostY+myScroll;zoomChangeW=endW-startW;zoomChangeH=endH-startH;if(t){tempSteps=zoomSteps*7}else{tempSteps=zoomSteps}zoomCurrent=0;if(includeFade==1){fadeCurrent=0;fadeAmount=(0-100)/tempSteps}else{fadeAmount=0}zoomTimer[theID]=setInterval("zoomElement('"+zoomID+"', '"+theID+"', "+zoomCurrent+", "+startW+", "+zoomChangeW+", "+startH+", "+zoomChangeH+", "+hostX+", "+zoomChangeX+", "+hostY+", "+zoomChangeY+", "+tempSteps+", "+includeFade+", "+fadeAmount+", 'zoomDoneIn(zoomID)')",zoomTime);zoomActive[theID]=true}}function zoomOut(e,t){if(getShift(t)){tempSteps=zoomSteps*7}else{tempSteps=zoomSteps}if(zoomActive[theID]!=true){if(document.getElementById("ShadowBox")){document.getElementById("ShadowBox").style.visibility="hidden"}else if(!browserIsIE){if(fadeActive["ZoomImage"]){clearInterval(fadeTimer["ZoomImage"]);fadeActive["ZoomImage"]=false;fadeTimer["ZoomImage"]=false}document.getElementById("ZoomImage").style.webkitBoxShadow=shadowSettings+"0.0)"}document.getElementById("ZoomClose").style.visibility="hidden";if(includeCaption&&document.getElementById(zoomCaption).innerHTML!=""){document.getElementById(zoomCaptionDiv).style.visibility="hidden"}startX=parseInt(zoomdiv.style.left);startY=parseInt(zoomdiv.style.top);startW=zoomimg.width;startH=zoomimg.height;zoomChangeX=zoomOrigX[theID]-startX;zoomChangeY=zoomOrigY[theID]-startY;zoomChangeW=zoomOrigW[theID]-startW;zoomChangeH=zoomOrigH[theID]-startH;zoomCurrent=0;if(includeFade==1){fadeCurrent=0;fadeAmount=(100-0)/tempSteps}else{fadeAmount=0}zoomTimer[theID]=setInterval("zoomElement('"+zoomID+"', '"+theID+"', "+zoomCurrent+", "+startW+", "+zoomChangeW+", "+startH+", "+zoomChangeH+", "+startX+", "+zoomChangeX+", "+startY+", "+zoomChangeY+", "+tempSteps+", "+includeFade+", "+fadeAmount+", 'zoomDone(zoomID, theID)')",zoomTime);zoomActive[theID]=true}}function zoomDoneIn(e,t){zoomOpen=true;e=document.getElementById(e);if(document.getElementById("ShadowBox")){setOpacity(0,"ShadowBox");shadowdiv=document.getElementById("ShadowBox");shadowLeft=parseInt(e.style.left)-13;shadowTop=parseInt(e.style.top)-8;shadowWidth=e.offsetWidth+26;shadowHeight=e.offsetHeight+26;shadowdiv.style.width=shadowWidth+"px";shadowdiv.style.height=shadowHeight+"px";shadowdiv.style.left=shadowLeft+"px";shadowdiv.style.top=shadowTop+"px";document.getElementById("ShadowBox").style.visibility="visible";fadeElementSetup("ShadowBox",0,100,5)}else if(!browserIsIE){fadeElementSetup("ZoomImage",0,.8,5,0,"shadow")}if(includeCaption&&document.getElementById(zoomCaption).innerHTML!=""){zoomcapd=document.getElementById(zoomCaptionDiv);zoomcapd.style.top=parseInt(e.style.top)+(e.offsetHeight+15)+"px";zoomcapd.style.left=myWidth/2-zoomcapd.offsetWidth/2+"px";zoomcapd.style.visibility="visible"}if(!browserIsIE)setOpacity(0,"ZoomClose");document.getElementById("ZoomClose").style.visibility="visible";if(!browserIsIE)fadeElementSetup("ZoomClose",0,100,5);document.onkeypress=getKey}function zoomDone(e,t){zoomOpen=false;zoomOrigH[t]="";zoomOrigW[t]="";document.getElementById(e).style.visibility="hidden";zoomActive[t]==false;document.onkeypress=null}function zoomElement(zoomdiv,theID,zoomCurrent,zoomStartW,zoomChangeW,zoomStartH,zoomChangeH,zoomStartX,zoomChangeX,zoomStartY,zoomChangeY,zoomSteps,includeFade,fadeAmount,execWhenDone){if(zoomCurrent==zoomSteps+1){zoomActive[theID]=false;clearInterval(zoomTimer[theID]);if(execWhenDone!=""){eval(execWhenDone)}}else{if(includeFade==1){if(fadeAmount<0){setOpacity(Math.abs(zoomCurrent*fadeAmount),zoomdiv)}else{setOpacity(100-zoomCurrent*fadeAmount,zoomdiv)}}moveW=cubicInOut(zoomCurrent,zoomStartW,zoomChangeW,zoomSteps);moveH=cubicInOut(zoomCurrent,zoomStartH,zoomChangeH,zoomSteps);moveX=cubicInOut(zoomCurrent,zoomStartX,zoomChangeX,zoomSteps);moveY=cubicInOut(zoomCurrent,zoomStartY,zoomChangeY,zoomSteps);document.getElementById(zoomdiv).style.left=moveX+"px";document.getElementById(zoomdiv).style.top=moveY+"px";zoomimg.style.width=moveW+"px";zoomimg.style.height=moveH+"px";zoomCurrent++;clearInterval(zoomTimer[theID]);zoomTimer[theID]=setInterval("zoomElement('"+zoomdiv+"', '"+theID+"', "+zoomCurrent+", "+zoomStartW+", "+zoomChangeW+", "+zoomStartH+", "+zoomChangeH+", "+zoomStartX+", "+zoomChangeX+", "+zoomStartY+", "+zoomChangeY+", "+zoomSteps+", "+includeFade+", "+fadeAmount+", '"+execWhenDone+"')",zoomTime)}}function getKey(e){if(!e){theKey=event.keyCode}else{theKey=e.keyCode}if(theKey==27){zoomOut(this,e)}}function fadeOut(e){if(e.id){fadeElementSetup(e.id,100,0,10)}}function fadeIn(e){if(e.id){fadeElementSetup(e.id,0,100,10)}}function fadeElementSetup(e,t,n,r,i,s){if(fadeActive[e]==true){fadeQueue[e]=new Array(e,t,n,r)}else{fadeSteps=r;fadeCurrent=0;fadeAmount=(t-n)/fadeSteps;fadeTimer[e]=setInterval("fadeElement('"+e+"', '"+fadeCurrent+"', '"+fadeAmount+"', '"+fadeSteps+"')",15);fadeActive[e]=true;fadeMode[e]=s;if(i==1){fadeClose[e]=true}else{fadeClose[e]=false}}}function fadeElement(e,t,n,r){if(t==r){clearInterval(fadeTimer[e]);fadeActive[e]=false;fadeTimer[e]=false;if(fadeClose[e]==true){document.getElementById(e).style.visibility="hidden"}if(fadeQueue[e]&&fadeQueue[e]!=false){fadeElementSetup(fadeQueue[e][0],fadeQueue[e][1],fadeQueue[e][2],fadeQueue[e][3]);fadeQueue[e]=false}}else{t++;if(fadeMode[e]=="shadow"){if(n<0){document.getElementById(e).style.webkitBoxShadow=shadowSettings+Math.abs(t*n)+")"}else{document.getElementById(e).style.webkitBoxShadow=shadowSettings+(100-t*n)+")"}}else{if(n<0){setOpacity(Math.abs(t*n),e)}else{setOpacity(100-t*n,e)}}clearInterval(fadeTimer[e]);fadeTimer[e]=setInterval("fadeElement('"+e+"', '"+t+"', '"+n+"', '"+r+"')",15)}}function setOpacity(e,t){var n=document.getElementById(t).style;if(navigator.userAgent.indexOf("Firefox")!=-1){if(e==100){e=99.9999}}n.filter="alpha(opacity="+e+")";n.opacity=e/100}function linear(e,t,n,r){return n*e/r+t}function sineInOut(e,t,n,r){return-n/2*(Math.cos(Math.PI*e/r)-1)+t}function cubicIn(e,t,n,r){return n*(e/=r)*e*e+t}function cubicOut(e,t,n,r){return n*((e=e/r-1)*e*e+1)+t}function cubicInOut(e,t,n,r){if((e/=r/2)<1)return n/2*e*e*e+t;return n/2*((e-=2)*e*e+2)+t}function bounceOut(e,t,n,r){if((e/=r)<1/2.75){return n*7.5625*e*e+t}else if(e<2/2.75){return n*(7.5625*(e-=1.5/2.75)*e+.75)+t}else if(e<2.5/2.75){return n*(7.5625*(e-=2.25/2.75)*e+.9375)+t}else{return n*(7.5625*(e-=2.625/2.75)*e+.984375)+t}}function getSize(){if(self.innerHeight){myWidth=window.innerWidth;myHeight=window.innerHeight;myScroll=window.pageYOffset}else if(document.documentElement&&document.documentElement.clientHeight){myWidth=document.documentElement.clientWidth;myHeight=document.documentElement.clientHeight;myScroll=document.documentElement.scrollTop}else if(document.body){myWidth=document.body.clientWidth;myHeight=document.body.clientHeight;myScroll=document.body.scrollTop}if(window.innerHeight&&window.scrollMaxY){myScrollWidth=document.body.scrollWidth;myScrollHeight=window.innerHeight+window.scrollMaxY}else if(document.body.scrollHeight>document.body.offsetHeight){myScrollWidth=document.body.scrollWidth;myScrollHeight=document.body.scrollHeight}else{myScrollWidth=document.body.offsetWidth;myScrollHeight=document.body.offsetHeight}}function getShift(e){var t=false;if(!e&&window.event){t=window.event.shiftKey}else if(e){t=e.shiftKey;if(t)e.stopPropagation()}return t}function findElementPos(e){var t=0;var n=0;do{t+=e.offsetLeft;n+=e.offsetTop}while(e=e.offsetParent);return Array(t,n)}var myWidth=0,myHeight=0,myScroll=0;myScrollWidth=0;myScrollHeight=0;var zoomOpen=false,preloadFrame=1,preloadActive=false,preloadTime=0,imgPreload=new Image;var preloadAnimTimer=0;var zoomActive=new Array;var zoomTimer=new Array;var zoomOrigW=new Array;var zoomOrigH=new Array;var zoomOrigX=new Array;var zoomOrigY=new Array;var zoomID="ZoomBox";var theID="ZoomImage";var zoomCaption="ZoomCaption";var zoomCaptionDiv="ZoomCapDiv";if(navigator.userAgent.indexOf("MSIE")!=-1){var browserIsIE=true}var fadeActive=new Array;var fadeQueue=new Array;var fadeTimer=new Array;var fadeClose=new Array;var fadeMode=new Array

// FancyZoomHTML.js - v1.0
// Used to draw necessary HTML elements for FancyZoom
//
// Copyright (c) 2008 Cabel Sasser / Panic Inc
// All rights reserved.
function insertZoomHTML(){var e=document.getElementsByTagName("body").item(0);var t=document.createElement("div");t.setAttribute("id","ZoomSpin");t.style.position="absolute";t.style.left="10px";t.style.top="10px";t.style.visibility="hidden";t.style.zIndex="525";e.insertBefore(t,e.firstChild);var n=document.createElement("img");n.setAttribute("id","SpinImage");n.setAttribute("src",zoomImagesURI+"zoom-spin-1.png");t.appendChild(n);var r=document.createElement("div");r.setAttribute("id","ZoomBox");r.style.position="absolute";r.style.left="10px";r.style.top="10px";r.style.visibility="hidden";r.style.zIndex="499";e.insertBefore(r,t.nextSibling);var i=document.createElement("img");i.onclick=function(e){zoomOut(this,e);return false};i.setAttribute("src",zoomImagesURI+"spacer.gif");i.setAttribute("id","ZoomImage");i.setAttribute("border","0");i.setAttribute("style","-webkit-box-shadow: "+shadowSettings+"0.0)");i.style.display="block";i.style.width="10px";i.style.height="10px";i.style.cursor="pointer";r.appendChild(i);var s=document.createElement("div");s.setAttribute("id","ZoomClose");s.style.position="absolute";if(browserIsIE){s.style.left="-1px";s.style.top="0px"}else{s.style.left="-15px";s.style.top="-15px"}s.style.visibility="hidden";r.appendChild(s);var o=document.createElement("img");o.onclick=function(e){zoomOut(this,e);return false};o.setAttribute("src",zoomImagesURI+"closebox.png");o.setAttribute("width","30");o.setAttribute("height","30");o.setAttribute("border","0");o.style.cursor="pointer";s.appendChild(o);if(!document.getElementById("ZoomImage").style.webkitBoxShadow&&!browserIsIE){var u=document.createElement("div");u.setAttribute("id","ShadowBox");u.style.position="absolute";u.style.left="50px";u.style.top="50px";u.style.width="100px";u.style.height="100px";u.style.visibility="hidden";u.style.zIndex="498";e.insertBefore(u,r.nextSibling);var a=document.createElement("table");a.setAttribute("border","0");a.setAttribute("width","100%");a.setAttribute("height","100%");a.setAttribute("cellpadding","0");a.setAttribute("cellspacing","0");u.appendChild(a);var f=document.createElement("tbody");a.appendChild(f);var l=document.createElement("tr");l.style.height="25px";f.appendChild(l);var c=document.createElement("td");c.style.width="27px";l.appendChild(c);var h=document.createElement("img");h.setAttribute("src",zoomImagesURI+"zoom-shadow1.png");h.setAttribute("width","27");h.setAttribute("height","25");h.style.display="block";c.appendChild(h);var p=document.createElement("td");p.setAttribute("background",zoomImagesURI+"zoom-shadow2.png");l.appendChild(p);var d=document.createElement("img");d.setAttribute("src",zoomImagesURI+"spacer.gif");d.setAttribute("height","1");d.setAttribute("width","1");d.style.display="block";p.appendChild(d);var v=document.createElement("td");v.style.width="27px";l.appendChild(v);var m=document.createElement("img");m.setAttribute("src",zoomImagesURI+"zoom-shadow3.png");m.setAttribute("width","27");m.setAttribute("height","25");m.style.display="block";v.appendChild(m);inRow2=document.createElement("tr");f.appendChild(inRow2);var g=document.createElement("td");g.setAttribute("background",zoomImagesURI+"zoom-shadow4.png");inRow2.appendChild(g);var y=document.createElement("img");y.setAttribute("src",zoomImagesURI+"spacer.gif");y.setAttribute("height","1");y.setAttribute("width","1");y.style.display="block";g.appendChild(y);var b=document.createElement("td");b.setAttribute("bgcolor","#ffffff");inRow2.appendChild(b);var w=document.createElement("img");w.setAttribute("src",zoomImagesURI+"spacer.gif");w.setAttribute("height","1");w.setAttribute("width","1");w.style.display="block";b.appendChild(w);var E=document.createElement("td");E.setAttribute("background",zoomImagesURI+"zoom-shadow5.png");inRow2.appendChild(E);var S=document.createElement("img");S.setAttribute("src",zoomImagesURI+"spacer.gif");S.setAttribute("height","1");S.setAttribute("width","1");S.style.display="block";E.appendChild(S);var x=document.createElement("tr");x.style.height="26px";f.appendChild(x);var T=document.createElement("td");T.style.width="27px";x.appendChild(T);var N=document.createElement("img");N.setAttribute("src",zoomImagesURI+"zoom-shadow6.png");N.setAttribute("width","27");N.setAttribute("height","26");N.style.display="block";T.appendChild(N);var C=document.createElement("td");C.setAttribute("background",zoomImagesURI+"zoom-shadow7.png");x.appendChild(C);var k=document.createElement("img");k.setAttribute("src",zoomImagesURI+"spacer.gif");k.setAttribute("height","1");k.setAttribute("width","1");k.style.display="block";C.appendChild(k);var L=document.createElement("td");L.style.width="27px";x.appendChild(L);var A=document.createElement("img");A.setAttribute("src",zoomImagesURI+"zoom-shadow8.png");A.setAttribute("width","27");A.setAttribute("height","26");A.style.display="block";L.appendChild(A)}if(includeCaption){var O=document.createElement("div");O.setAttribute("id","ZoomCapDiv");O.style.position="absolute";O.style.visibility="hidden";O.style.marginLeft="auto";O.style.marginRight="auto";O.style.zIndex="501";e.insertBefore(O,r.nextSibling);var M=document.createElement("table");M.setAttribute("border","0");M.setAttribute("cellPadding","0");M.setAttribute("cellSpacing","0");O.appendChild(M);var _=document.createElement("tbody");M.appendChild(_);var D=document.createElement("tr");_.appendChild(D);var P=document.createElement("td");P.setAttribute("align","right");D.appendChild(P);var H=document.createElement("img");H.setAttribute("src",zoomImagesURI+"zoom-caption-l.png");H.setAttribute("width","13");H.setAttribute("height","26");H.style.display="block";P.appendChild(H);var B=document.createElement("td");B.setAttribute("background",zoomImagesURI+"zoom-caption-fill.png");B.setAttribute("id","ZoomCaption");B.setAttribute("valign","middle");B.style.fontSize="14px";B.style.fontFamily="Helvetica";B.style.fontWeight="bold";B.style.color="#ffffff";B.style.textShadow="0px 2px 4px #000000";B.style.whiteSpace="nowrap";D.appendChild(B);var j=document.createElement("td");D.appendChild(j);var F=document.createElement("img");F.setAttribute("src",zoomImagesURI+"zoom-caption-r.png");F.setAttribute("width","13");F.setAttribute("height","26");F.style.display="block";j.appendChild(F)}}