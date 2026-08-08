/*
 * Kyryll Tenin Baum © 2014
*/
(function ($) {

    var kyryll = {
		
		SCREEN_WIDTH: 0,
		SCREEN_HEIGHT: 0,
		SCREEN_WIDTH_HALF: 0,
		SCREEN_HEIGHT_HALF: 0,
		FOOTER_HEIGHT_WIDTH_RATIO: 3,
		RENDERER_FOOTER_HEIGHT: 0,
		RENDERER_MAIN_HEIGHT: 0,
		
		vid: "",
		nov: 0,
		fv: null,
		name: "",
		email: "",
		isMobile: false,
		
		birdCameraMain: null,
		birdCameraFooter: null,
		birdScene: null,
		birdRendererMain: null,
		birdRendererFooter: null,
		birds: null,
		boid: null,
		boids: null,
		
		navIntro: null,
		navAbout: null,
		navWork: null,
		navContact: null,
		clouds: null,
		fireworks: null,
		odessa: null,
		currentView: null,
		currentViewAnimating: false,
		
        init: function () {
			
			window.kyryll = kyryll; // accessible scope for debugging
			
			console.log("Initialising..");
			
			kyryll.setupIdentity();
			
			kyryll.preloadImages();
			kyryll.preloadSound();
			
            setupZoom(); // exposed by FancyZoom
			
			kyryll.setupCloudsParallax();
	        kyryll.setupInertialScrollingAndCycling();
	        kyryll.setupCanvasVars();
	        kyryll.setupBirdAnimation();
			kyryll.setupContactForm();
			//kyryll.renderBirdsAnimationFrame(); // do after fireworks and background animations
			
			kyryll.renderWelcomeAnimation(3000, kyryll.renderMainContent);
        },
		
		setupIdentity: function () {
			
			kyryll.determineMobileBrowser();
			
			kyryll.vid = kyryll.getCookie("vid");
			kyryll.nov = kyryll.getCookie("nov");
			kyryll.fv = kyryll.getCookie("fv");
			kyryll.name = kyryll.getCookie("name");
			kyryll.email = kyryll.getCookie("em");
			
			if (!kyryll.vid) {
				kyryll.vid = kyryll.generateGuid();
				kyryll.setCookie("vid", kyryll.vid);
			}
			
			if (!kyryll.nov) {
				kyryll.nov = 1;
			} else {
				kyryll.nov++;
			}
			kyryll.setCookie("nov", kyryll.nov);
			
			if (!kyryll.fv) {
				var today = new Date();
				kyryll.fv = today.getDate() + "/" + (today.getMonth() + 1) + "/" + today.getFullYear();
				kyryll.setCookie("fv", kyryll.fv);
			}
			
			kyryll.gaSendPageView("intro");
		},
		
		gaSendPageView: function (page) {
			
			if (typeof ga == "function") {
				ga("send", "pageview", {
					page: "/#" + page,
					title: "Kyryll - " + page,
					VID:  kyryll.vid ? kyryll.vid : "0",
					NOV: kyryll.nov ? kyryll.nov : "0",
					FV: kyryll.fv ? kyryll.fv : "0",
					M: kyryll.isMobile
				});
			}
			
			kyryll.sendMessage(null, "Navigated to page \"" + page + "\"");
		},
		
		preloadImages: function () {
			
			console.log("Loading images..");
			
			ImageCacheFooter= new Image(256,256);
			ImageCacheFooter.src = "img/grid.png";
			
			ImageCacheFooter= new Image(1920,640);
			ImageCacheFooter.src = "img/bgfooter.png";
			
			ImageCacheBackground = new Image(1680,1000);
			ImageCacheBackground.src = "img/bg1.jpg";
			
			ImageCacheClouds = new Image(1650,500);
			ImageCacheClouds.src = "img/bg-clouds.png";
			
			ImageCacheTree = new Image(72,125);
			ImageCacheTree.src = "img/tree.png";
			
			// delay preloading images that are not needed at the start by 30 seconds
			setTimeout(function () {
				
				ImageCacheTree = new Image(449,309);
				ImageCacheTree.src = "img/envelope-flap-1.png";
				
				ImageCacheTree = new Image(449,309);
				ImageCacheTree.src = "img/envelope-flap-2.png";
				
				ImageCacheTree = new Image(449,309);
				ImageCacheTree.src = "img/envelope-flap-3.png";
				
				ImageCacheTree = new Image(449,309);
				ImageCacheTree.src = "img/envelope-full.png";
				
			}, 30000);
		},
		
		preloadSound: function () {
			
			console.log("Loading sound..");
			
			kyryll.odessa = new Howl({
				urls: ["sound/odessa.mp3", "sound/odessa.m4a", "sound/odessa.ogg"],
				onload: function(){
					$("#sound").css("background-image", kyryll.isMobile ? "url(img/sound-icon-red.png)" : "url(img/sound-icon-green.png)").toggle(kyryll.isMobile);
				},
				onend: function() {
					$("#sound").css("background-image", "url(img/sound-icon-green.png)");
				},
				sprite: {
					init: [0, 50],
					firework: [0, 1900],
					full: [0, 300015]
				}
			}); //.play();
			
			$("#sound").click(function () {
				kyryll.odessa.play("init");
			});
		},
		
		renderWelcomeAnimation: function (delay, callback) {
			
			console.log("Rendering welcome animation..");
			
			$("p.loading-term").cooltext({
				sequence:[
      				{action:"animation", animation:"cool24"}
	  			],
	  			onComplete:function(value){
		  			$("p.loading-definition").first().cooltext({
						sequence:[
		      				{action:"animation", animation:"cool37"}
			  			],
			  			onComplete:function(value){
				  			$("p.loading-definition").last().cooltext({
								sequence:[
				      				{action:"animation", animation:"cool37"}
					  			],
					  			onComplete:function(value){
						  			
						  			setTimeout(function () {
							  			
										$("#loading-splash").fadeOut(1500, function () {
											
											$("#content").fadeIn(1500, function () {
												if (typeof callback == "function")
													callback();
											});
										});
									
									}, (delay ? delay : 3000));
								},
				   			});
						},
		   			});
				}
   			});
		},
		
		renderMainContent: function () {
			
			console.log("Rendering main content..");
			
			kyryll.fireworks = new Fireworks();
			
			setTimeout(function () {
				
				if (kyryll.odessa) {
					
					kyryll.odessa.play("firework");
					setTimeout(function () {
						kyryll.odessa.play("firework");
					}, 1000);
					setTimeout(function () {
						kyryll.odessa.play("firework");
					}, 1300);
					setTimeout(function () {
						kyryll.odessa.play("firework");
					}, 1800);
					setTimeout(function () {
						kyryll.odessa.play("full");
					}, 1700);
				}
				
				$("#container").fadeIn(7000, function () {
					kyryll.fadeBlackToTransparent($("#clouds"), 100, 0, function () {
						
						$(".intro a").cooltext({
							sequence:[
			      					{action:"animation", animation:"cool58"}
				  			],
				  			onComplete:function(value){
				  				$(".about a, .work a, .contact a").cooltext({
									sequence:[
			      						{action:"animation", animation:"cool55"}
				  					]
				  				});
				  			}
				  		});
				  		
						kyryll.renderBirdsAnimationFrame();
					});
				});
			}, 3000);
			
			console.log("Everything loaded");
		},
		
        fadeBlackToTransparent: function (element, from, to, callback) {
            element.css("background-color", "rgba(0, 0, 0, " + (from += from > to ? -1 : 1) / 100 + ")");
            if (from != to)
                setTimeout(function () { kyryll.fadeBlackToTransparent(element, from, to, callback) }, 20);
            else if (typeof callback == "function")
                callback();
        },

        setupCloudsParallax: function () {
			
            function calculateCloudParallax(tileheight, speedratio, scrollposition) {
                return ((tileheight) - (Math.floor(scrollposition / speedratio) % (tileheight + 1)));
            }
			
			if ($("#clouds").length) {
				
				kyryll.clouds = $("#clouds")[0];
				
	            $(window).on("scroll", function () {
	                var posY = (document.documentElement.scrollTop != null && document.documentElement.scrollTop != 0) ? document.documentElement.scrollTop : window.pageYOffset;
	                var cloudsparallax = calculateCloudParallax(500, .4, posY);
	                kyryll.clouds.style.backgroundPosition = "0 " + cloudsparallax + "px";
	            });
            }
        },

        setupInertialScrollingAndCycling: function () {
			
			function calculateNavMarginOffset (parentHeight) {
				//return parentHeight > 696 ? (parentHeight - 696) / 5.98 : 0; // linear version with min cap
				return parentHeight * 0.293 - 243.679; // linear version with no cap based on my MacBook Air 13' inch and MacBook Pro 17'
			}
			
			if ($(".nav").length == 4) {
				
				kyryll.navIntro = $(".nav")[0];
				kyryll.navAbout = $(".nav")[1];
				kyryll.navWork = $(".nav")[2];
				kyryll.navContact = $(".nav")[3];
				
				// jQuery conditionally bypassed for better performance
				$(window).on("resize", function () {
					var margin = calculateNavMarginOffset(window.innerHeight);
					if (kyryll.isMobile) {
						$(".nav").animate({ "margin-bottom": margin + "px" }, { duration: 1500, easing: "easeInCirc" });
					} else {
						kyryll.navIntro.style.marginBottom = margin + "px";
						kyryll.navAbout.style.marginBottom = margin + "px";
						kyryll.navWork.style.marginBottom = margin + "px";
						kyryll.navContact.style.marginBottom = margin + "px";
					}
				});
				
				var margin = calculateNavMarginOffset(window.innerHeight);
				kyryll.navIntro.style.marginBottom = margin + "px";
				kyryll.navAbout.style.marginBottom = margin + "px";
				kyryll.navWork.style.marginBottom = margin + "px";
				kyryll.navContact.style.marginBottom = margin + "px";
			}
			
			$(document).on("touchmove", function(event){
				event.preventDefault();
			});
            
            $("#foliothumbs").cycle();
			
            $(".nav, .folio, .welcome").localScroll({
                duration: 2000,
                onBefore: function (e, anchor, target) {
                    $(".outer").removeClass("important");
                },
                onAfter: function (e, anchor, $target) {
                    
                    kyryll.currentView = e;
                    
                    $(e).addClass("important");
					
					var pageName = $(e).attr("id");
					
					if (!kyryll.currentViewAnimating) {
						window.history.pushState({section: pageName}, $(e).text(), "");
					} else {
						kyryll.currentViewAnimating = false;
					}
					
					kyryll.gaSendPageView(pageName);
                }
            });

            $(".outer").each(function () {

				var subnav = this;

                $(".subnav", this).localScroll({
                    target: $(".content", this),
                    duration: 1500,
                    hash: false,
                    axis: "xy",
                    queue: true,
                    onBefore: function (e, anchor, target) {
                        $(".scrolled", subnav).removeClass("scrolled");
                        $("a[href='#" + anchor.id + "']", subnav).addClass("scrolled");
                        $(this).blur();
                    },
	                onAfter: function (e, anchor, $target) {
	                	
	                	var pageNameParent = $(kyryll.currentView).attr("id");
						var pageName = $(e).attr("id");
						
						kyryll.gaSendPageView(pageNameParent + " - " + pageName);
	                }
                });

                $("li.sub p, li.sub li", this).localScroll({
                    target: $(".content", this),
                    axis: "xy",
                    queue: true,
                    hash: false,
                    duration: 1500,
	                onAfter: function (e, anchor, $target) {
	                	
	                	var pageNameParent = $(kyryll.currentView).attr("id");
						var pageName = $(e).attr("id");
						
						kyryll.gaSendPageView(pageNameParent + " - " + pageName);
	                }

                });
            });
            
			window.onpopstate = function (e) {
				if (e.state && e.state.section) {
					console.log("Animating to state " + e.state.section + "..");
					$(window).scrollTop(kyryll.currentView.offset().top);
					kyryll.currentViewAnimating = true;
					$(".nav a[href='#" + e.state.section + "']").first().click();
				}
			}
            
            window.history.replaceState({section: "intro"}, "", "");
        },

        setupBirdAnimation: function () {

            kyryll.Bird.prototype = Object.create(THREE.Geometry.prototype);

            kyryll.birdCameraMain = new THREE.PerspectiveCamera(75, kyryll.SCREEN_WIDTH / kyryll.SCREEN_HEIGHT, 1, 10000);
            kyryll.birdCameraMain.setViewOffset(kyryll.SCREEN_WIDTH, kyryll.SCREEN_HEIGHT, 0, 0, kyryll.SCREEN_WIDTH, kyryll.RENDERER_MAIN_HEIGHT);
            kyryll.birdCameraMain.position.z = 450;

            kyryll.birdCameraFooter = new THREE.PerspectiveCamera(75, kyryll.SCREEN_WIDTH / kyryll.SCREEN_HEIGHT, 1, 10000);
            kyryll.birdCameraFooter.setViewOffset(kyryll.SCREEN_WIDTH, kyryll.SCREEN_HEIGHT, 0, kyryll.RENDERER_MAIN_HEIGHT, kyryll.SCREEN_WIDTH, kyryll.RENDERER_FOOTER_HEIGHT);
            kyryll.birdCameraFooter.position.z = 450;

            kyryll.birdScene = new THREE.Scene();

            kyryll.birds = [];
            kyryll.boids = [];

            var bird = null;

            for (var i = 0; i < 11; i++) {

                kyryll.boid = kyryll.boids[i] = new kyryll.Boid();

                kyryll.boid.position.x = Math.random() * 400 - 800; //200
                kyryll.boid.position.y = Math.random() * 400 + 400; //200
                kyryll.boid.position.z = Math.random() * 400 - 200; //200
                kyryll.boid.velocity.x = Math.random() * 2 - 1;
                kyryll.boid.velocity.y = Math.random() * 2 - 1;
                kyryll.boid.velocity.z = Math.random() * 2 - 1;
                kyryll.boid.setAvoidWalls(true);
                //kyryll.boid.setWorldSize( 500, 500, 400 );
                kyryll.boid.setWorldSize(kyryll.SCREEN_HEIGHT, kyryll.SCREEN_WIDTH, 400);

                bird = kyryll.birds[i] = new THREE.Mesh(new kyryll.Bird(), new THREE.MeshBasicMaterial({
                    color: Math.random() * 0xffffff,
                    side: THREE.DoubleSide
                }));

                bird.phase = Math.floor(Math.random() * 62.83);
                bird.position = kyryll.boids[i].position;
                kyryll.birdScene.add(bird);


            }

            kyryll.birdRendererMain = new THREE.CanvasRenderer();
            //kyryll.birdRendererMain.autoClear = false;
            kyryll.birdRendererMain.setSize(kyryll.SCREEN_WIDTH, kyryll.RENDERER_MAIN_HEIGHT);

            kyryll.birdRendererFooter = new THREE.CanvasRenderer();
            //kyryll.birdRendererFooter.autoClear = false;
            kyryll.birdRendererFooter.setSize(kyryll.SCREEN_WIDTH, kyryll.RENDERER_FOOTER_HEIGHT);

            $(kyryll.birdRendererMain.domElement).attr("id", "birdsMain").css({
                "position": "fixed",
                "top": "0",
                "left": "0",
                "margin-bottom": "0",
                "vertical-align": "bottom"
            });
            $(kyryll.birdRendererFooter.domElement).attr("id", "birdsFooter").css({
                "position": "fixed",
                "background-attachment": "scroll",
                "pointer-events": "none",
                "top": kyryll.RENDERER_MAIN_HEIGHT + "px",
                "left": "0",
                "margin-top": "0"
            });

            //document.body.appendChild(kyryll.birdRendererMain.domElement);
            //document.body.appendChild(kyryll.birdRendererFooter.domElement);
			document.getElementById("content").appendChild(kyryll.birdRendererMain.domElement)
			document.getElementById("content").appendChild(kyryll.birdRendererFooter.domElement)
			
            document.addEventListener('mousemove', kyryll.onDocumentMouseMove, false);
            window.addEventListener('resize', kyryll.onWindowResize, false);

        },

        setupCanvasVars: function () {

            kyryll.SCREEN_WIDTH = window.innerWidth;
            kyryll.SCREEN_HEIGHT = window.innerHeight;
            kyryll.SCREEN_WIDTH_HALF = kyryll.SCREEN_WIDTH / 2;
            kyryll.SCREEN_HEIGHT_HALF = kyryll.SCREEN_HEIGHT / 2;
            kyryll.RENDERER_FOOTER_HEIGHT = kyryll.SCREEN_WIDTH / kyryll.FOOTER_HEIGHT_WIDTH_RATIO;
            kyryll.RENDERER_MAIN_HEIGHT = kyryll.SCREEN_HEIGHT - kyryll.RENDERER_FOOTER_HEIGHT;
        },

        onWindowResize: function () {

            kyryll.setupCanvasVars();

            $(kyryll.birdRendererFooter.domElement).css("top", kyryll.RENDERER_MAIN_HEIGHT + "px");

            kyryll.birdCameraMain.aspect = window.innerWidth / kyryll.RENDERER_MAIN_HEIGHT;
            kyryll.birdCameraMain.updateProjectionMatrix();

            kyryll.birdRendererMain.setSize(window.innerWidth, kyryll.RENDERER_MAIN_HEIGHT);

            kyryll.birdCameraFooter.aspect = window.innerWidth / kyryll.RENDERER_FOOTER_HEIGHT;
            kyryll.birdCameraFooter.updateProjectionMatrix();

            kyryll.birdRendererFooter.setSize(window.innerWidth, kyryll.RENDERER_FOOTER_HEIGHT);
        },
		
        onDocumentMouseMove: function (event) {

            var vector = new THREE.Vector3(event.clientX - kyryll.SCREEN_WIDTH_HALF, -event.clientY + kyryll.SCREEN_HEIGHT_HALF, 0);

            for (var i = 0, il = kyryll.boids.length; i < il; i++) {

                var boid = kyryll.boids[i];

                vector.z = boid.position.z;

                boid.repulse(vector);
            }
        },
		
        renderBirdsAnimationFrame: function () {

            requestAnimationFrame(kyryll.renderBirdsAnimationFrame);

            for (var i = 0, il = kyryll.birds.length; i < il; i++) {

                var boid = kyryll.boids[i];
                boid.run(kyryll.boids);

                var bird = kyryll.birds[i];

                color = bird.material.color;
                color.r = color.g = color.b = (500 - bird.position.z) / 1000;

                bird.rotation.y = Math.atan2(-boid.velocity.z, boid.velocity.x);
                bird.rotation.z = Math.asin(boid.velocity.y / boid.velocity.length());

                bird.phase = (bird.phase + (Math.max(0, bird.rotation.z) + 0.1)) % 62.83;
                bird.geometry.vertices[5].y = bird.geometry.vertices[4].y = Math.sin(bird.phase) * 5;
            }

            kyryll.birdRendererMain.render(kyryll.birdScene, kyryll.birdCameraMain);
            kyryll.birdRendererFooter.render(kyryll.birdScene, kyryll.birdCameraFooter);
        },
        
        getGeolocation: function (callback) {
	        
	        if (navigator.geolocation && typeof navigator.geolocation.getCurrentPosition == "function") {
				
				var j = 100, av = j;
				var avLat = 0;
				var avLon = 0;
				
				for (var i = 0; i < av; i++) {
					navigator.geolocation.getCurrentPosition(processAverage);
				}
				
				function processAverage(pos) {
					avLat += pos.coords.latitude;
					avLon += pos.coords.longitude;
					j--;
					if (j == 0) {
						avLat = avLat / av;
						avLon = avLon / av;
						if (typeof callback == "function") {
							callback(avLat, avLon);
						}
					}
				}
			}
        },
		
		setupContactForm: function () {
			
			$.fn.serialiseObject = function() {
			    var o = {};
			    var a = this.serializeArray();
			    $.each(a, function() {
			        if (o[this.name] !== undefined) {
			            if (!o[this.name].push) {
			                o[this.name] = [o[this.name]];
			            }
			            o[this.name].push(this.value || '');
			        } else {
			            o[this.name] = this.value || '';
			        }
			    });
			    return o;
			};

			$("#sendername").keyup(function (e) {
			    var e = window.event || e;
			    if (e !== undefined) {
			        var keyUnicode = e.charCode || e.keyCode;
			        if (keyUnicode == 13) {
			            $("#email").focus();
			        }
			    }
			});
			
			$("#email").keyup(function (e) {
			    var e = window.event || e;
			    if (e !== undefined) {
			        var keyUnicode = e.charCode || e.keyCode;
			        if (keyUnicode == 13) {
			            $("#phone").focus();
			        }
			    }
			});
			
			$("#phone").keyup(function (e) {
			    var e = window.event || e;
			    if (e !== undefined) {
			        var keyUnicode = e.charCode || e.keyCode;
			        if (keyUnicode == 13) {
			            $("#comments").focus();
			        }
			    }
			});
			
			$("#contactform input[type!='button'], #contactform textarea").jrumble({
				x: 3,
				y: 2,
				rotation: 1
			}).label_better({
				position: kyryll.isMobile ? "right" : "left",
				animationTime: 500,
				easing: "ease-in-out",
				offset: kyryll.isMobile ? 325 : 5,
				hidePlaceholderOnFocus: true
			});
			
			$("#submit").click(function () {
				kyryll.sendMessage(this);
				//kyryll.completeContactForm();
			});
			
			$("#cancel").click(function () {
				kyryll.shatterContactForm();
			});
		},
		
		sendMessage: function (element, trigger) {
			
			var data = element && !trigger ? $(element).closest("form").serialiseObject() : {info: trigger};
			data = $.extend({sendername: kyryll.name ? kyryll.name : "", email: kyryll.email ? kyryll.email : "", phone: "", vid: kyryll.vid, nov: kyryll.nov, fv: kyryll.fv, ismobile: kyryll.isMobile}, data);
			
			data.info += "\n\rReferrer: " + document.referrer;
			
			if ($("#sendername").val() != "") {
				kyryll.setCookie("name", $("#sendername").val());
			}
			
			if ($("#senderemail").val() != "") {
				kyryll.setCookie("em", $("#senderemail").val());
			}

		    $.ajax({
		        type: "GET",
		        url: "https://email.kyryll.com/v1/send",
				data: {
					fromEmail: 'visitor@kyryll.com',
					fromName: 'Kyryll\'s Site',
					toEmail: 'site@kyryll.com',
					toName: 'Kyryll',
					subject: element && !trigger ? 'New Site Message' : 'Site Event',
					plainContent: JSON.stringify(data),
					htmlContent: JSON.stringify(data)
				},
		        success: function (xml) {
		            
		            if (element) {
			            
			            switch ($("status", xml).text()) {
			                
			                case '1':
								
			                    kyryll.completeContactForm($("message", xml).text());
								
			                    break;
								
			                case '2':
			                    
			                    $("#tipsSendMail").text($("message", xml).text());
			                    
			                    $("#" + $("field", xml).text()).css("border", "1px solid #dd0000")
			                    .bind("focus blur", function () {
								    $(this).css("border", "1px solid #333333").trigger("stopRumble");
								}).trigger("startRumble");
								
								setTimeout(function () { $("#" + $("field", xml).text()).trigger("stopRumble"); }, 5000);
								
			                    break;
								
			                default:
			                
			                    // Something bad happened, and it wasn't a validation error
								$("#tipsSendMail").text($("message", xml).text());
								
			                    break;
			            }
		            }
		        },
		        error: function (xml, message) {
		            $("#tipsSendMail").text("Could not reach the server");
		        }
		    });
		},
		
		completeContactForm: function () {
			
			var sectionSize = kyryll.splitContactFormIntoSections(3);
			
			$("#contactform").css({"perspective": "250px", "-webkit-perspective": "250px"});
			
			$("#contactform div.clipped[count=2]").css("transform-origin", "50% " + sectionSize.height + "px 0").animate({rotationX: -180}, {
				duration: 1000,
				easing: "easeInCirc",
				complete: function () {
					$(this).remove();
					$("#contactform div.clipped[count=5], #contactform div.clipped[count=8]").css("transform-origin", 2 * sectionSize.width + "px 50% 0").animate({rotationY: -180}, {
						duration: 500,
						easing: "easeInCirc",
						complete: function () {
							$(this).remove();
							
							$("#contactform div.clipped[count=4]").empty().css({
								"width": $("#contactform div.clipped[count=4]").attr("width") + "px",
								"height": $("#contactform div.clipped[count=4]").attr("height") + "px",
								"margin-left": $("#contactform div.clipped[count=4]").attr("width") + "px",
								"margin-top": $("#contactform div.clipped[count=4]").attr("height") + "px",
								"background-size": "contain",
								"background-repeat": "no-repeat",
								"clip": "auto",
								"background-image": "url(img/envelope-flap-1.png)"
							});
							
							$("#contactform div.clipped[count=6], #contactform div.clipped[count=7]").css("transform-origin", "50% " + 2 * sectionSize.height + "px 0").animate({rotationX: 180}, {
								duration: 500,
								easing: "easeInCirc",
								complete: function () {
									$(this).remove();
									
									$("#contactform div.clipped[count=4]").empty().css({
										"background-image": "url(img/envelope-flap-2.png)"
									});
									
									$("#contactform div.clipped[count=0], #contactform div.clipped[count=3]").css("transform-origin", sectionSize.width + "px 50% 0").animate({rotationY: 180}, {
										duration: 500,
										easing: "easeInCirc",
										complete: function () {
											$(this).remove();
											
											$("#contactform div.clipped[count=4]").empty().css({
												"background-image": "url(img/envelope-flap-3.png)"
											});
											
											$("#contactform div.clipped[count=1]").css("transform-origin", "50% " + sectionSize.height + "px 0").animate({rotationX: -180}, {
												duration: 500,
												easing: "easeInCirc",
												complete: function () {
													
													$(this).remove();
													
													$("#contactform div.clipped[count=4]").empty().css({
														"background-image": "url(img/envelope-full.png)"
													});
													
													setTimeout(function () {
														
														var coord = $("#contactform div.clipped[count=4]").position();
														
														TweenMax.to($("#contactform div.clipped[count=4]"), kyryll.rand(7, 15), {
															bezier: {
																curviness:1.25,
																values:[
																	{x:100, y:100, rotationX:0, rotationY:0},
																	{x:500, y:-50, rotationX:kyryll.rand(30, -30), rotationY:kyryll.rand(5, -5)},
																	{x:kyryll.rand(560, 420), y:kyryll.rand(0, 100), rotationX:kyryll.rand(5, -5), rotationY:kyryll.rand(10, -10)},
																	{x:400, y:-50, rotationX:kyryll.rand(25, -25), rotationY:kyryll.rand(10, -10)},
																	{x:300, y:-70, rotationX:kyryll.rand(5, -5), rotationY:kyryll.rand(5, -5)},
																	{x:400, y:-100, rotationX:kyryll.rand(15, -15), rotationY:kyryll.rand(5, -5)},
																	{x:1600, y:kyryll.rand(1200, -300), rotationX:5, rotationY:10}
																],
																autoRotate:true
															},
															ease: Power1.easeInOut,
															onComplete: function(){
																kyryll.cleanupContactFormAnimation();
															}
														});
													}, 500);
												}
											});
										}
									});
								}
							});
						}
					});
				}
			});
		},
		
		shatterContactForm: function (callback) {
			
			var sectionSize = kyryll.splitContactFormIntoSections(5);
			
			//$("#contactform div:not(#contactfieldset)").each(function(i) {
			$("#contactform div.clipped").each(function(i) {
				
				var v = kyryll.rand(120, 90),
					angle = kyryll.rand(80, 89),
					theta = (angle * Math.PI) / 180, // radians
					g = -9.8; // gravity, earth = 9.8 but lower gravity makes for better visual
				
				var self = $(this);
				
				var t = 0,
					z, r, nx, ny,
					totalt =  20;
				
				// horizontal direction can either be left (1), right (-1) or center (0)
				var negate = [1, -1, 0],
					direction = negate[ Math.floor(Math.random() * negate.length) ];
				
				var randDeg = kyryll.rand(-5, 10), 
					randScale = kyryll.rand(0.9, 1.1),
					randDeg2 = kyryll.rand(30, 5);
				
				var color = $(this).css("backgroundColor").split("rgba(")[1].split(")")[0].split(", "),
					colorR = kyryll.rand(-20, 20), // change color slightly
					colorGB = kyryll.rand(-20, 20),  // change color slightly
					newColor = "rgb(" + (parseFloat(color[0]) + colorR) + ", " + (parseFloat(color[1]) + colorGB) + ", " + (parseFloat(color[2]) + colorGB) + ")";
				
				$(this).css({
					transform : "scale(" + randScale + ") skew(" + randDeg + "deg) rotateZ(" + randDeg2 + "deg)" //, background: newColor
				});
				
				z = setInterval(function() { 	
					
					var ux = ( Math.cos(theta) * v ) * direction; // horizontal speed is constant
					var uy = ( Math.sin(theta) * v ) - ( (-g) * t); // vertical speed decreases as time increases before reaching 0 at its peak
					
					nx = (ux * t);
					ny = (uy * t) + (0.5 * (g) * Math.pow(t, 2)); // s = ut + 0.5at^2
					
					$(self).css({bottom: (ny) + "px", left: (nx) + "px"});
					
					t = t + 0.10; // increase the time
					
					if(t > totalt) {
						
						clearInterval(z);
						
						if (i == sectionSize.totalSquares - 1) {
							kyryll.cleanupContactFormAnimation();
							if (typeof callback == "function") {
								callback();
							}
						}
					}
					
				}, 10); // run every 10ms
			});
		},
		
		splitContactFormIntoSections: function (number) {
			
			$t = $("#contactform");
			
			var width = $t.width() / number;
			var height = $t.height() / number;
			var totalSquares = Math.pow(number, 2);
			var html = $t.find("#contactfieldset").html();
			var count = 0;
			
			var y = 0;
			
			for(var z = 0; z <= (number * width); z = z + width) {
			
				$("<div class='clipped' count='" + count + "' width='" + width + "' height='" + height + "' style='position: absolute; clip: rect(" + y + "px, " + (z + width) + "px, " + (y + height) + "px, " + z + "px); backface-visibility: hidden; -webkit-backface-visibility: hidden;'>" + html + "</div>").appendTo($t);
				
				if(z === (number * width) - width) {
				
					y = y + height;
					z = -width;
				
				}
				
				if(y === (number * height)) {
					z = 9999999;
				}
				
				count++;
			}
			
			$t.find("div.clipped input[name='sendername']").val($t.find("#contactfieldset input[name='sendername']").val());
			$t.find("div.clipped input[name='email']").val($t.find("#contactfieldset input[name='email']").val());
			$t.find("div.clipped input[name='phone']").val($t.find("#contactfieldset input[name='phone']").val());
			$t.find("div.clipped textarea[name='comments']").val($t.find("#contactfieldset textarea[name='comments']").val());
			
			$("#contactform #contactfieldset").css({display: "none"});
			
			return {totalSquares: totalSquares, width: width, height: height};
		},
		
		cleanupContactFormAnimation: function () {
			
			//$("#contactform div:not(#contactfieldset)").remove();
			$("#contactform div.clipped").remove();
			$("#contactform input:not([type='button'])").val("").blur().each(function() {$(this).attr("placeholder", $(this).attr("data-new-placeholder"))});
			$("#contactform textarea").val("").blur().each(function() {$(this).attr("placeholder", $(this).attr("data-new-placeholder"))});
			$("#contactform #contactfieldset").fadeIn("slow");
			$("#contactform #tipsSendMail").text("");
		},
		
		rand: function (min, max) {
			return Math.floor(Math.random() * (max - min + 1)) + min;
		},
		
		generateGuid: function () {
			
			var guid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx";
			
			guid = guid.replace(/[xy]/g, function(c) {
				var r = Math.random()*16|0, v = c == 'x' ? r : (r&0x3|0x8);
				return v.toString(16);
			});

			return guid;
		},
		
		determineMobileBrowser: function () {
			
			// based on http://detectmobilebrowsers.com
			var a = navigator.userAgent||navigator.vendor||window.opera;
			kyryll.isMobile = /(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows (ce|phone)|xda|xiino|android|ipad|playbook|silk/i.test(a)||/1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(a.substr(0,4));
		},
		
		setCookie: function (name, value, exdays) {
			
			var exdate = new Date();
			exdate.setDate(exdate.getDate() + exdays);
			var value = escape(value) + ((exdays == null) ? "" : "; expires=" + exdate.toUTCString());
			document.cookie = name + "=" + value;
		},
		
		getCookie: function (name) {
			
			var i, x, y, arrCookies = document.cookie.split(";");
			for (i = 0; i < arrCookies.length; i++) {
				x = arrCookies[i].substr(0, arrCookies[i].indexOf("="));
				y = arrCookies[i].substr(arrCookies[i].indexOf("=") + 1);
				x = x.replace(/^\s+|\s+$/g, "");
				if (x == name) {
					return unescape(y);
				}
			}
		},
		
        Boid: function () {
			
            var vector = new THREE.Vector3(),
                _acceleration, _width = 500,
                _height = 500,
                _depth = 200,
                _goal, _neighborhoodRadius = 100,
                _maxSpeed = 4,
                _maxSteerForce = 0.1,
                _avoidWalls = false;

            this.position = new THREE.Vector3();
            this.velocity = new THREE.Vector3();
            _acceleration = new THREE.Vector3();
			
            this.setGoal = function (target) {

                _goal = target;
            }
			
            this.setAvoidWalls = function (value) {

                _avoidWalls = value;
            }
			
            this.setWorldSize = function (width, height, depth) {

                _width = width;
                _height = height;
                _depth = depth;
            }
			
            this.run = function (boids) {

                if (_avoidWalls) {
					
					vector.set(-_width, this.position.y, this.position.z);
					vector = this.avoid(vector);
					vector.multiplyScalar(5);
					_acceleration.add(vector);
					
					vector.set(_width, this.position.y, this.position.z);
					vector = this.avoid(vector);
					vector.multiplyScalar(5);
					_acceleration.add(vector);
					
					vector.set(this.position.x, -_height, this.position.z);
					vector = this.avoid(vector);
					vector.multiplyScalar(5);
					_acceleration.add(vector);
					
					vector.set(this.position.x, _height, this.position.z);
					vector = this.avoid(vector);
					vector.multiplyScalar(5);
					_acceleration.add(vector);
					
					vector.set(this.position.x, this.position.y, -_depth);
					vector = this.avoid(vector);
					vector.multiplyScalar(5);
					_acceleration.add(vector);
					
					vector.set(this.position.x, this.position.y, _depth);
					vector = this.avoid(vector);
					vector.multiplyScalar(5);
					_acceleration.add(vector);
					
                }
                /*else {
                    this.checkBounds();
                }
                */

                if (Math.random() > 0.5) {
                    this.flock(boids);
                }

                this.move();
            }
			
            this.flock = function (boids) {

                if (_goal) {
                    _acceleration.add(this.reach(_goal, 0.005));
                }

                _acceleration.add(this.alignment(boids));
                _acceleration.add(this.cohesion(boids));
                _acceleration.add(this.separation(boids));
            }
			
            this.move = function () {

                this.velocity.add(_acceleration);

                var l = this.velocity.length();

                if (l > _maxSpeed) {

                    this.velocity.divideScalar(l / _maxSpeed);

                }

                this.position.add(this.velocity);
                _acceleration.set(0, 0, 0);
            }
			
            this.checkBounds = function () {

                if (this.position.x > _width) this.position.x = -_width;
                if (this.position.x < -_width) this.position.x = _width;
                if (this.position.y > _height) this.position.y = -_height;
                if (this.position.y < -_height) this.position.y = _height;
                if (this.position.z > _depth) this.position.z = -_depth;
                if (this.position.z < -_depth) this.position.z = _depth;
            }
			
            this.avoid = function (target) {

                var steer = new THREE.Vector3();

                steer.copy(this.position);
                steer.sub(target);

                steer.multiplyScalar(1 / this.position.distanceToSquared(target));

                return steer;
            }
			
            this.repulse = function (target) {

                var distance = this.position.distanceTo(target);

                if (distance < 150) {

                    var steer = new THREE.Vector3();

                    steer.subVectors(this.position, target);
                    steer.multiplyScalar(0.5 / distance);

                    _acceleration.add(steer);

                }
            }
			
            this.reach = function (target, amount) {

                var steer = new THREE.Vector3();

                steer.subVectors(target, this.position);
                steer.multiplyScalar(amount);

                return steer;
            }
			
            this.alignment = function (boids) {

                var boid, velSum = new THREE.Vector3(),
                    count = 0;

                for (var i = 0, il = boids.length; i < il; i++) {

                    if (Math.random() > 0.6) continue;

                    boid = boids[i];

                    distance = boid.position.distanceTo(this.position);

                    if (distance > 0 && distance <= _neighborhoodRadius) {

                        velSum.add(boid.velocity);
                        count++;
                    }
                }

                if (count > 0) {

                    velSum.divideScalar(count);

                    var l = velSum.length();

                    if (l > _maxSteerForce) {

                        velSum.divideScalar(l / _maxSteerForce);
                    }
                }
                return velSum;
            }
			
            this.cohesion = function (boids) {

                var boid, distance,
                    posSum = new THREE.Vector3(),
                    steer = new THREE.Vector3(),
                    count = 0;

                for (var i = 0, il = boids.length; i < il; i++) {

                    if (Math.random() > 0.6) continue;

                    boid = boids[i];
                    distance = boid.position.distanceTo(this.position);

                    if (distance > 0 && distance <= _neighborhoodRadius) {

                        posSum.add(boid.position);
                        count++;
                    }
                }

                if (count > 0) {

                    posSum.divideScalar(count);
                }

                steer.subVectors(posSum, this.position);

                var l = steer.length();

                if (l > _maxSteerForce) {

                    steer.divideScalar(l / _maxSteerForce);
                }
                return steer;
            }
			
            this.separation = function (boids) {

                var boid, distance,
                    posSum = new THREE.Vector3(),
                    repulse = new THREE.Vector3();

                for (var i = 0, il = boids.length; i < il; i++) {

                    if (Math.random() > 0.6) continue;

                    boid = boids[i];
                    distance = boid.position.distanceTo(this.position);

                    if (distance > 0 && distance <= _neighborhoodRadius) {

                        repulse.subVectors(this.position, boid.position);
                        repulse.normalize();
                        repulse.divideScalar(distance);
                        posSum.add(repulse);
                    }
                }
                return posSum;
            }
        },
		
        Bird: function () {

            var scope = this;

            THREE.Geometry.call(this);

            v(5, 0, 0);
            v(-5, -2, 1);
            v(-5, 0, 0);
            v(-5, -2, -1);

            v(0, 2, -6);
            v(0, 2, 6);
            v(2, 0, 0);
            v(-3, 0, 0);

            f3(0, 2, 1);
            // f3( 0, 3, 2 );

            f3(4, 7, 6);
            f3(5, 6, 7);

            this.computeCentroids();
            this.computeFaceNormals();

            function v(x, y, z) {

                scope.vertices.push(new THREE.Vector3(x, y, z));
            }

            function f3(a, b, c) {

                scope.faces.push(new THREE.Face3(a, b, c));
            }
        }
    };

    $(document).ready(function () {
    	// Mutex "kyryllFontsLoaded" is declared in util.js and is invoked once all the fonts have been loaded
    	kyryllFontsLoaded.add(function()
		{
			kyryll.init();
		});
	});
	
})(jQuery);